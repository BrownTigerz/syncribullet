// Manual undo — remove ONE item from one Simkl history.
//
// This is the single deliberate exception to the build's add-only
// rule. It exists for the accident the live paths can create: an
// instant mark (own or mirror) for something that was only started,
// or a mirror copy TK wants off Ange's Simkl. It is driven only by
// the configure page's "Remove From Simkl History" section through
// POST /api/remove-history — per item, by hand, never automatic,
// never batch, and never called by the reconciler.
//
// Semantics per target:
// - own:    POST /sync/history/remove against the pair's own Simkl.
//           The pair's Watch Together baseline is NOT touched. If the
//           item is still flagged watched in Stremio, the reconciler
//           will add it back on its next run — the undo removes the
//           Simkl record, not the Stremio state.
// - mirror: POST /sync/history/remove against the pair's mirror
//           (Watch Together) Simkl, then the item is ADDED to the
//           pair's Watch Together baseline (the reload-and-mutate
//           updatePairWatchTogether), so the reconciler's mirror pass
//           treats it as "already there before the switch-on" and
//           never copies it again. If the pair has no valid baseline,
//           the removal still happens and the response says the
//           baseline step was skipped.
//
// Token lifecycle matches the other writers (reconciler syncTarget,
// live mirror): proactive refresh inside the token's last day, one
// refresh-and-retry on a 401, refreshed tokens persisted through
// updatePairAuth for whichever target was used.
//
// Secrecy: no tokens or credentials are logged — pair names, IMDb
// ids, HTTP status codes and Simkl's confirmed counts only, through
// the debug log under scope `remove`.

import { writeDebugLog } from './debug-log.mjs';
import { buildMirrorPayload, formatPickedItem } from './live-mirror.mjs';
import {
  getDataDir,
  loadPairs,
  updatePairAuth,
  updatePairWatchTogether,
} from './pairs-store.mjs';
import {
  formatRemovedCounts,
  parseRemovedCounts,
  refreshSimklAuth,
  removeFromHistory,
} from './simkl.mjs';
import { HttpError } from './stremio.mjs';
import {
  addToWatchTogetherBaseline,
  isWatchTogetherBaseline,
} from './watch-together-baseline.mjs';

const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMDB_ID = /^tt\d+$/;

/** A client/upstream failure with the HTTP status the route returns. */
export class RemoveHistoryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RemoveHistoryError';
    this.status = status;
  }
}

function badRequest(message) {
  return new RemoveHistoryError(400, message);
}

function parseCountField(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * Validate a remove-history request body:
 * { pairName, target: 'own' | 'mirror', imdb, season?, episode? }.
 * Season and episode must come together (an episode item) or not at
 * all (a movie item). Returns { pairName, target, item } with
 * item = { imdb, season, episode } (season/episode undefined for a
 * movie). Throws RemoveHistoryError(400) on any violation.
 */
export function validateRemoveRequest(body) {
  if (!body || typeof body !== 'object') {
    throw badRequest('Missing request body');
  }
  const pairName =
    typeof body.pairName === 'string' ? body.pairName.trim() : '';
  if (!pairName) {
    throw badRequest('A pair name is required');
  }
  if (body.target !== 'own' && body.target !== 'mirror') {
    throw badRequest('Target must be "own" or "mirror"');
  }
  const imdb = typeof body.imdb === 'string' ? body.imdb.trim() : '';
  if (!IMDB_ID.test(imdb)) {
    throw badRequest('IMDb Id must look like tt0121955');
  }
  const hasSeason =
    body.season !== undefined && body.season !== null && body.season !== '';
  const hasEpisode =
    body.episode !== undefined && body.episode !== null && body.episode !== '';
  if (hasSeason !== hasEpisode) {
    throw badRequest(
      'Season and Episode must be given together — both for an episode, neither for a movie',
    );
  }
  let season;
  let episode;
  if (hasSeason) {
    season = parseCountField(body.season);
    episode = parseCountField(body.episode);
    if (season === null || episode === null || season < 0 || episode < 1) {
      throw badRequest(
        'Season and Episode must be whole numbers (Season 0 or up, Episode 1 or up)',
      );
    }
  }
  return { pairName, target: body.target, item: { imdb, season, episode } };
}

/**
 * Remove one item from one Simkl history. The *Fn options are
 * injection seams for tests; production uses the real pair store and
 * Simkl helpers. Resolves with the result object the API route
 * returns; throws RemoveHistoryError for validation (400), unknown
 * pair (400), and Simkl-side failures (502).
 */
export async function removeHistoryItem({
  body,
  secret = process.env.PRIVATE_ENCRYPTION_KEY,
  dataDir = getDataDir(),
  loadPairsFn = loadPairs,
  removeFn = removeFromHistory,
  refreshAuthFn = refreshSimklAuth,
  persistAuthFn = updatePairAuth,
  updateWatchTogetherFn = updatePairWatchTogether,
  dbg = (message) => writeDebugLog('remove', message, dataDir),
} = {}) {
  const { pairName, target, item } = validateRemoveRequest(body);
  if (!secret) {
    throw new RemoveHistoryError(
      500,
      'PRIVATE_ENCRYPTION_KEY is not set on the server',
    );
  }

  const pairs = loadPairsFn(secret, dataDir);
  const pair = (pairs || []).find((entry) => entry.name === pairName);
  if (!pair) {
    throw badRequest(`No saved pair named "${pairName}"`);
  }

  const targetKey = target === 'mirror' ? 'mirrorSimkl' : 'simkl';
  let auth = pair[targetKey];
  if (!auth?.access_token || !auth?.client_id) {
    throw badRequest(
      target === 'mirror'
        ? `Pair "${pairName}" has no Watch Together mirror account connected`
        : `Pair "${pairName}" has no Simkl account connected`,
    );
  }

  const label = formatPickedItem(item);
  // The remove endpoint takes exactly the /sync/history payload shape.
  const payload = buildMirrorPayload(item);

  const persist = (newAuth) => {
    auth = newAuth;
    try {
      persistAuthFn(pairName, targetKey, newAuth, secret, dataDir);
    } catch (e) {
      dbg(
        `token refresh could not be saved for pair ${pairName} (${target}) — ${e.message}`,
      );
    }
  };

  // Proactive refresh, same rule as the other writers.
  if (
    auth.refresh_token &&
    auth.expires_at &&
    auth.expires_at - Date.now() < REFRESH_WINDOW_MS
  ) {
    try {
      persist(await refreshAuthFn(auth));
    } catch (e) {
      dbg(
        `token refresh failed for pair ${pairName} (${target}) — ${e.message}; trying the current token`,
      );
    }
  }

  let status = null;
  let removed = null;
  const attempt = async () => {
    const result = await removeFn(auth, payload);
    status = result.status;
    removed = parseRemovedCounts(result.data);
  };
  try {
    await attempt();
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) {
      throw new RemoveHistoryError(502, `Simkl removal failed: ${e.message}`);
    }
    if (!auth.refresh_token) {
      throw new RemoveHistoryError(
        502,
        'Simkl returned 401 and no refresh token is stored. Reconnect Simkl for this pair.',
      );
    }
    try {
      persist(await refreshAuthFn(auth));
    } catch (refreshError) {
      throw new RemoveHistoryError(
        502,
        `Simkl token refresh failed: ${refreshError.message}. Reconnect Simkl for this pair.`,
      );
    }
    try {
      await attempt();
    } catch (retryError) {
      if (retryError instanceof HttpError && retryError.status === 401) {
        throw new RemoveHistoryError(
          502,
          'Simkl still returned 401 after a token refresh. Reconnect Simkl for this pair.',
        );
      }
      throw new RemoveHistoryError(
        502,
        `Simkl removal failed: ${retryError.message}`,
      );
    }
  }

  const confirmed = formatRemovedCounts(removed);
  dbg(
    `removed ${label} from ${target} of pair ${pairName} (HTTP ${status})${confirmed ? ` — ${confirmed}` : ''}`,
  );

  // Mirror removals also land in the starting point, so the
  // reconciler never copies the item across again. Reload first:
  // the baseline must be mutated from the store's current state.
  let baselineUpdated = false;
  let baselineNote = null;
  if (target === 'mirror') {
    let freshPair = pair;
    try {
      freshPair =
        loadPairsFn(secret, dataDir).find(
          (entry) => entry.name === pairName,
        ) || pair;
    } catch {
      // Keep the pair loaded above; the baseline check still applies.
    }
    if (isWatchTogetherBaseline(freshPair.watchTogetherBaseline)) {
      const newBaseline = addToWatchTogetherBaseline(
        freshPair.watchTogetherBaseline,
        item,
      );
      try {
        if (
          updateWatchTogetherFn(
            pairName,
            { baseline: newBaseline },
            secret,
            dataDir,
          )
        ) {
          baselineUpdated = true;
          dbg(
            `added ${label} to the Watch Together starting point of pair ${pairName} — it will not be copied again`,
          );
        }
      } catch (e) {
        dbg(
          `could not add ${label} to the Watch Together starting point of pair ${pairName} — ${e.message}`,
        );
      }
    } else {
      baselineNote = 'no-baseline';
    }
  }

  const note =
    target === 'mirror'
      ? baselineUpdated
        ? "Removed, and added to the Watch Together starting point so it won't be copied again."
        : 'Removed from the mirror Simkl history. No Watch Together starting point is saved for this pair, so there was nothing to add it to.'
      : "Removed from this pair's Simkl history. If the item is still flagged watched in Stremio, the reconciler will add it back on its next run.";

  return {
    ok: true,
    pairName,
    target,
    item,
    label,
    status,
    removed,
    baselineUpdated,
    baselineNote,
    note,
  };
}
