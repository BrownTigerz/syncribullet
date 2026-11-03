// Instant Watch Together mirror for live stream picks.
//
// The reconciler's mirror pass (reconcile.mjs) is the mechanism of
// record: it mirrors (current watched set - baseline) to the Watch
// Together mirror account on its schedule. This module is the fast
// path beside it. When a stream pick through the fork addon causes a
// live Simkl write to the picker's own account, the same item is also
// posted to the mirror account in the same moment — still gated by the
// pair's Watch Together baseline, so a re-pick of anything watched
// before Watch Together was switched on mirrors nothing. The on/off
// gate is the effective mode (the WATCH_TOGETHER .env solo/together
// override when set, else the pair's stored flag), shared with the
// reconciler via effectiveWatchTogether.
//
// Pair matching: the addon config that made the pick carries the
// picker's own Simkl app client_id (Simkl app per person, see
// SETUP.md Step 4). A saved pair stores that same client_id in
// pair.simkl.client_id, so the pair whose pair.simkl.client_id equals
// the config's client_id is the picker's pair. The access token cannot
// be used for this: the config holds its own grant and the pair's
// stored token is refreshed/replaced over time, while the client_id
// is stable for the life of the app. Matching is against
// pair.simkl.client_id ONLY — never pair.mirrorSimkl.client_id — so
// Ange's picks match Ange's pair (Watch Together off, nothing
// mirrors), never TK's pair through its mirror credentials.
//
// Token lifecycle mirrors reconcile.mjs syncTarget for the mirror
// target: proactive refresh when the mirror access token is inside
// its last day, one refresh-and-retry on a 401, refreshed tokens
// persisted back into the pair store via updatePairAuth.
//
// Fail-silent toward the caller by contract: mirrorLivePick never
// throws and is meant to be fired without awaiting it, so the stream
// response is never delayed or broken by a mirror problem. Anything
// missed here is still picked up by the next reconciler run.
//
// Secrecy: no tokens, authKeys, or config strings are ever logged —
// item IMDb ids, HTTP status codes, and pair names only, through the
// debug log under scope `live` (DEBUG_LOG=0 silences these too).

import { writeDebugLog } from './debug-log.mjs';
import { getDataDir, loadPairs, updatePairAuth } from './pairs-store.mjs';
import {
  formatAddedCounts,
  postHistory,
  refreshSimklAuth,
} from './simkl.mjs';
import { HttpError } from './stremio.mjs';
import {
  effectiveWatchTogether,
  isWatchTogetherBaseline,
} from './watch-together-baseline.mjs';

const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Debug-log label for one picked item: `tt0096697` / `tt0096697 S37E12`. */
export function formatPickedItem(item) {
  return isEpisodeItem(item)
    ? `${item.imdb} S${item.season}E${item.episode}`
    : String(item.imdb);
}

function isEpisodeItem(item) {
  return Number.isFinite(item?.season) && Number.isFinite(item?.episode);
}

/** The pair whose own Simkl app made this pick, or undefined. */
export function findPairForClientId(pairs, clientId) {
  if (!clientId) {
    return undefined;
  }
  return (pairs || []).find((pair) => pair?.simkl?.client_id === clientId);
}

/**
 * Is this single picked item inside the pair's Watch Together
 * baseline? Same scheme as the reconciler: movies by IMDb id,
 * episodes by "season:episode" key under the show's IMDb id.
 */
export function itemInBaseline(baseline, item) {
  if (isEpisodeItem(item)) {
    const episodes = baseline.shows?.[item.imdb];
    return (
      Array.isArray(episodes) &&
      episodes.includes(`${item.season}:${item.episode}`)
    );
  }
  return baseline.movies.includes(item.imdb);
}

/**
 * Pure mirror decision for one live pick:
 *   { action: 'none', reason, pair? }     — not applicable; stay silent
 *   { action: 'excluded', pair }          — in the baseline; log + stop
 *   { action: 'post', pair }              — post to the mirror account
 * 'none' covers every ordinary case (no pair for this config, Watch
 * Together off, no mirror account connected, no valid baseline) so the
 * caller logs nothing for picks Watch Together does not apply to.
 *
 * The on/off gate is the EFFECTIVE mode (effectiveWatchTogether):
 * the WATCH_TOGETHER .env override when set, else the pair's stored
 * flag — the same gate the reconciler uses, so the solo/together
 * switch silences (or enables) both mirror paths together. One extra
 * guard: when the pair's last applied mode is 'off', a switch-on has
 * not been applied by the reconciler yet and the stored baseline is
 * still the pre-solo one — mirroring against it could copy solo
 * watches across, so the pick skips silently until a reconcile run
 * captures the fresh starting point and flips the applied mode.
 */
export function decideLiveMirror({ pairs, clientId, item, env = process.env }) {
  const pair = findPairForClientId(pairs, clientId);
  if (!pair) {
    return { action: 'none', reason: 'no-pair' };
  }
  if (!effectiveWatchTogether(pair, env)) {
    return { action: 'none', reason: 'watch-together-off', pair };
  }
  if (pair.watchTogetherAppliedMode === 'off') {
    return { action: 'none', reason: 'switch-pending', pair };
  }
  if (!pair.mirrorSimkl?.access_token || !pair.mirrorSimkl?.client_id) {
    return { action: 'none', reason: 'no-mirror-account', pair };
  }
  if (!isWatchTogetherBaseline(pair.watchTogetherBaseline)) {
    return { action: 'none', reason: 'no-baseline', pair };
  }
  if (itemInBaseline(pair.watchTogetherBaseline, item)) {
    return { action: 'excluded', pair };
  }
  return { action: 'post', pair };
}

/** /sync/history payload for one picked item, reconciler mirror shape. */
export function buildMirrorPayload(item) {
  if (isEpisodeItem(item)) {
    return {
      movies: [],
      shows: [
        {
          ids: { imdb: item.imdb },
          seasons: [
            { number: item.season, episodes: [{ number: item.episode }] },
          ],
        },
      ],
    };
  }
  return { movies: [{ ids: { imdb: item.imdb } }], shows: [] };
}

/**
 * Mirror one live pick to the Watch Together mirror account.
 * Never throws. Returns the decision/result object for tests and
 * harnesses; production callers fire-and-forget it.
 *
 * item: { imdb, season?, episode? } — season/episode both present for
 * an episode pick, both absent for a movie pick.
 * The *Fn options are injection seams for tests; production uses the
 * real pair store and Simkl helpers.
 */
export async function mirrorLivePick({
  clientId,
  item,
  secret = process.env.PRIVATE_ENCRYPTION_KEY,
  dataDir = getDataDir(),
  loadPairsFn = loadPairs,
  postHistoryFn = postHistory,
  refreshAuthFn = refreshSimklAuth,
  persistAuthFn = updatePairAuth,
  env = process.env,
  dbg = (message) => writeDebugLog('live', message, dataDir),
} = {}) {
  try {
    if (!item?.imdb || !clientId || !secret) {
      return { action: 'none', reason: 'missing-input' };
    }

    let pairs;
    try {
      pairs = loadPairsFn(secret, dataDir);
    } catch (e) {
      dbg(
        `mirror skipped — could not read the saved pairs (${e.message}); the reconciler will cover this watch`,
      );
      return { action: 'none', reason: 'pairs-unreadable' };
    }

    const decision = decideLiveMirror({ pairs, clientId, item, env });
    if (decision.action !== 'post' && decision.action !== 'excluded') {
      return decision;
    }

    const label = formatPickedItem(item);
    if (decision.action === 'excluded') {
      dbg(`mirror excluded (in baseline) ${label}`);
      return decision;
    }

    const pair = decision.pair;
    let auth = pair.mirrorSimkl;
    const persist = (newAuth) => {
      auth = newAuth;
      try {
        persistAuthFn(pair.name, 'mirrorSimkl', newAuth, secret, dataDir);
      } catch (e) {
        dbg(
          `mirror token refresh could not be saved for pair ${pair.name} — ${e.message}`,
        );
      }
    };

    // Proactive refresh, same rule as the reconciler's syncTarget.
    if (
      auth.refresh_token &&
      auth.expires_at &&
      auth.expires_at - Date.now() < REFRESH_WINDOW_MS
    ) {
      try {
        persist(await refreshAuthFn(auth));
        dbg(`mirror Simkl token refreshed for pair ${pair.name}`);
      } catch (e) {
        dbg(
          `mirror Simkl token refresh failed for pair ${pair.name} — ${e.message}; trying the current token`,
        );
      }
    }

    const payload = buildMirrorPayload(item);
    let status = null;
    let added = null;
    const onPost = (info) => {
      status = info.status;
      if (info.added) {
        added = info.added;
      }
    };
    try {
      await postHistoryFn(auth, payload, onPost);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) {
        dbg(`mirror failed ${label} — ${e.message}; the reconciler will retry`);
        return { action: 'failed', reason: 'post-failed', pair };
      }
      // One refresh-and-retry on a rejected mirror token, as syncTarget.
      if (!auth.refresh_token) {
        dbg(
          `mirror failed ${label} — Simkl returned 401 and no mirror refresh token is stored; the reconciler will retry`,
        );
        return { action: 'failed', reason: 'no-refresh-token', pair };
      }
      try {
        persist(await refreshAuthFn(auth));
      } catch (refreshError) {
        dbg(
          `mirror failed ${label} — Simkl token refresh failed: ${refreshError.message}; the reconciler will retry`,
        );
        return { action: 'failed', reason: 'refresh-failed', pair };
      }
      try {
        await postHistoryFn(auth, payload, onPost);
      } catch (retryError) {
        dbg(
          `mirror failed ${label} — ${retryError.message}; the reconciler will retry`,
        );
        return { action: 'failed', reason: 'post-failed', pair };
      }
    }

    const confirmed = formatAddedCounts(added);
    dbg(
      `mirror posted ${label}${status ? ` (HTTP ${status})` : ''}${confirmed ? ` — ${confirmed}` : ''}`,
    );
    return { action: 'posted', pair };
  } catch (e) {
    // The mirror must never break the caller — log and swallow.
    try {
      dbg(
        `mirror failed ${item?.imdb || 'unknown-id'} — ${e.message}; the reconciler will retry`,
      );
    } catch {
      // Even the log failed; nothing more to do.
    }
    return { action: 'failed', reason: 'unexpected' };
  }
}
