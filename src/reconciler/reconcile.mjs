// Server-side scheduled reconciler — the mechanism of record for
// SimklStremio. Live sync in the addon is a fast path only; this runner
// is what guarantees "tracked without downtime":
//
//   Every run does a FULL state diff per saved pair:
//     Stremio account datastore (watched movies + watched episodes)
//       vs Simkl's actual library state (GET /sync/all-items)
//   and POSTs /sync/history only for watched items Simkl is missing.
//   There is no watermark or local ledger deciding what is synced, so a
//   run after any amount of downtime backfills everything in between.
//   A failed run changes nothing and is retried on the next run.
//
// Add-only: the only Simkl write anywhere in the reconciler is
// POST /sync/history. Nothing is ever removed, moved, or added to a list.
//
// Watch Together is the one exception to "diff the full watched set":
// the mirror account receives only (current watched set - the baseline
// captured when Watch Together was switched on), diffed against the
// mirror's own library. A Watch Together pair with no valid baseline
// mirrors nothing and is flagged needsBaseline — a full-history mirror
// is never used as a fallback.

import { createDebugLogger } from './debug-log.mjs';
import {
  getDataDir,
  loadPairs,
  readStatus,
  updatePairAuth,
  writeStatus,
} from './pairs-store.mjs';
import {
  fetchSimklLibrary,
  postHistory,
  refreshSimklAuth,
  simklHasEpisode,
} from './simkl.mjs';
import { extractWatched, fetchStremioLibrary, HttpError } from './stremio.mjs';
import {
  isWatchTogetherBaseline,
  subtractWatchTogetherBaseline,
} from './watch-together-baseline.mjs';

const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

function buildPayload(watched, simklLibrary) {
  const movies = [];
  // Per-item decisions for the debug log:
  // { kind: 'movie'|'episode', imdb, season?, episode?, present }
  const decisions = [];
  for (const imdb of watched.movies.keys()) {
    const present = simklLibrary.movies.has(imdb);
    decisions.push({ kind: 'movie', imdb, present });
    if (!present) {
      movies.push({ ids: { imdb } });
    }
  }

  const shows = [];
  let addedEpisodes = 0;
  for (const [imdb, show] of watched.shows.entries()) {
    const simklShow = simklLibrary.shows.get(imdb);
    const missingBySeason = new Map();
    for (const key of show.episodes) {
      const [season, episode] = key.split(':').map((n) => parseInt(n, 10));
      const present = simklHasEpisode(simklShow, season, episode);
      decisions.push({ kind: 'episode', imdb, season, episode, present });
      if (!present) {
        if (!missingBySeason.has(season)) {
          missingBySeason.set(season, []);
        }
        missingBySeason.get(season).push(episode);
        addedEpisodes++;
      }
    }
    if (missingBySeason.size > 0) {
      shows.push({
        ids: { imdb },
        seasons: [...missingBySeason.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, episodes]) => ({
            number,
            episodes: episodes
              .sort((a, b) => a - b)
              .map((episodeNumber) => ({ number: episodeNumber })),
          })),
      });
    }
  }

  return { payload: { movies, shows }, addedEpisodes, decisions };
}

function formatDecision(decision) {
  return decision.kind === 'movie'
    ? decision.imdb
    : `${decision.imdb} S${decision.season}E${decision.episode}`;
}

async function attemptSync(auth, watched, { dbg, scope, mirror = false } = {}) {
  const simklLibrary = await fetchSimklLibrary(auth);
  if (dbg) {
    const libraryEpisodeCount = [...simklLibrary.shows.values()].reduce(
      (total, show) => total + (show.episodes?.size || 0),
      0,
    );
    dbg(
      scope,
      `${mirror ? 'Mirror Simkl' : 'Simkl'} library fetched — ${simklLibrary.movies.size} movie(s), ${simklLibrary.shows.size} show(s), ${libraryEpisodeCount} episode(s)`,
    );
  }
  const { payload, addedEpisodes, decisions } = buildPayload(
    watched,
    simklLibrary,
  );
  const toAdd = [];
  for (const decision of decisions) {
    if (decision.present) {
      if (dbg) {
        dbg(
          scope,
          mirror
            ? `excluded (already on mirror library) ${formatDecision(decision)}`
            : `already on Simkl ${formatDecision(decision)}`,
        );
      }
    } else {
      toAdd.push(decision);
    }
  }
  if (payload.movies.length === 0 && payload.shows.length === 0) {
    return { addedMovies: 0, addedEpisodes: 0 };
  }
  try {
    await postHistory(auth, payload, (info) => {
      if (dbg) {
        dbg(
          scope,
          `POST /sync/history — ${info.movies} movie(s), ${info.shows} show(s) → HTTP ${info.status}`,
        );
      }
    });
  } catch (e) {
    if (dbg) {
      dbg(scope, `POST /sync/history failed — ${e.message}`);
    }
    throw e;
  }
  if (dbg) {
    for (const decision of toAdd) {
      dbg(
        scope,
        mirror
          ? `posted to mirror ${formatDecision(decision)}`
          : `added ${formatDecision(decision)}`,
      );
    }
  }
  return { addedMovies: payload.movies.length, addedEpisodes };
}

/**
 * Sync one pair's watched state into one Simkl account.
 * Handles the AUTH V2 token lifecycle: proactive refresh when the access
 * token is inside its last day, and one refresh-and-retry on a 401.
 * Refreshed tokens are persisted through persistAuth (the reconciler is
 * the single owner of the server-side grants — see docs/SIMKL_AUTH.md).
 */
async function syncTarget({
  pairName,
  targetKey,
  auth,
  watched,
  secret,
  dataDir,
  log,
  dbg,
  mirror = false,
}) {
  let currentAuth = auth;
  const scope = mirror ? `mirror:${pairName}` : `pair:${pairName}`;

  const persist = async (newAuth) => {
    currentAuth = newAuth;
    try {
      updatePairAuth(pairName, targetKey, newAuth, secret, dataDir);
    } catch (e) {
      log.error(
        `[reconciler] ${pairName}: could not persist refreshed Simkl token: ${e.message}`,
      );
      if (dbg) {
        dbg(scope, `could not persist refreshed Simkl token — ${e.message}`);
      }
    }
  };

  if (
    currentAuth.refresh_token &&
    currentAuth.expires_at &&
    currentAuth.expires_at - Date.now() < REFRESH_WINDOW_MS
  ) {
    if (dbg) {
      dbg(scope, 'Simkl token inside its last day — refreshing proactively');
    }
    try {
      await persist(await refreshSimklAuth(currentAuth));
      if (dbg) {
        dbg(scope, 'proactive Simkl token refresh succeeded');
      }
    } catch (e) {
      log.warn(
        `[reconciler] ${pairName}: proactive Simkl refresh failed (${e.message}); continuing with the current token.`,
      );
      if (dbg) {
        dbg(
          scope,
          `proactive Simkl token refresh failed — ${e.message}; continuing with the current token`,
        );
      }
    }
  }

  try {
    return await attemptSync(currentAuth, watched, { dbg, scope, mirror });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) {
      throw e;
    }
    if (dbg) {
      dbg(scope, 'Simkl returned 401 (token rejected)');
    }
    if (!currentAuth.refresh_token) {
      if (dbg) {
        dbg(scope, 'no refresh token stored — needsReauth');
      }
      const err = new Error(
        'Simkl returned 401 and no refresh token is stored. Reconnect Simkl for this pair.',
      );
      err.needsReauth = true;
      throw err;
    }
    log.warn(
      `[reconciler] ${pairName}: Simkl token rejected (401); refreshing and retrying once.`,
    );
    if (dbg) {
      dbg(scope, 'refreshing Simkl token and retrying once');
    }
    try {
      await persist(await refreshSimklAuth(currentAuth));
      if (dbg) {
        dbg(scope, 'Simkl token refresh succeeded; retrying sync');
      }
    } catch (refreshError) {
      if (dbg) {
        dbg(
          scope,
          `Simkl token refresh failed — ${refreshError.message} — needsReauth`,
        );
      }
      const err = new Error(
        `Simkl token refresh failed: ${refreshError.message}. Reconnect Simkl for this pair.`,
      );
      err.needsReauth = true;
      throw err;
    }
    try {
      return await attemptSync(currentAuth, watched, { dbg, scope, mirror });
    } catch (retryError) {
      if (retryError instanceof HttpError && retryError.status === 401) {
        if (dbg) {
          dbg(scope, 'Simkl still returned 401 after refresh — needsReauth');
        }
        const err = new Error(
          'Simkl still returned 401 after a token refresh. Reconnect Simkl for this pair.',
        );
        err.needsReauth = true;
        throw err;
      }
      throw retryError;
    }
  }
}

export async function reconcilePair(pair, { secret, dataDir, log = console }) {
  const dbg = createDebugLogger(dataDir);
  const pairScope = `pair:${pair.name}`;
  const mirrorScope = `mirror:${pair.name}`;
  const startedAt = new Date().toISOString();
  const entry = {
    lastRunAt: startedAt,
    lastSuccessAt: null,
    lastError: null,
    needsReauth: false,
    needsBaseline: false,
    addedMovies: 0,
    addedEpisodes: 0,
    mirrorAddedMovies: 0,
    mirrorAddedEpisodes: 0,
    skipped: 0,
  };

  dbg(pairScope, 'run started');

  try {
    const libraryItems = await fetchStremioLibrary(pair.stremioAuthKey);
    dbg(
      pairScope,
      `Stremio library fetched — ${libraryItems.length} item(s)`,
    );
    const watched = await extractWatched(libraryItems, log);
    entry.skipped = watched.skipped;
    const watchedEpisodeCount = [...watched.shows.values()].reduce(
      (total, show) => total + show.episodes.size,
      0,
    );
    dbg(
      pairScope,
      `watched state extracted — ${watched.movies.size} movie(s), ${watched.shows.size} show(s), ${watchedEpisodeCount} episode(s), ${watched.skipped} skipped`,
    );
    for (const skippedItem of watched.skippedItems || []) {
      dbg(
        pairScope,
        `skipped (${skippedItem.reason}) id=${skippedItem.id} type=${skippedItem.type}`,
      );
    }

    const primary = await syncTarget({
      pairName: pair.name,
      targetKey: 'simkl',
      auth: pair.simkl,
      watched,
      secret,
      dataDir,
      log,
      dbg,
    });
    entry.addedMovies = primary.addedMovies;
    entry.addedEpisodes = primary.addedEpisodes;

    if (pair.watchTogether) {
      if (!isWatchTogetherBaseline(pair.watchTogetherBaseline)) {
        // No safe starting point: mirror NOTHING. Falling back to the
        // full watched set here would copy the pair's entire history to
        // the mirror account, which is exactly what the baseline exists
        // to prevent. The pair's own reconcile above is unaffected.
        entry.needsBaseline = true;
        log.error(
          `[reconciler] ${pair.name}: Watch Together is on but no starting-point baseline is stored; mirroring nothing. Save the pair again with Watch Together on to capture the starting point.`,
        );
        dbg(
          mirrorScope,
          'Watch Together is on but no valid baseline is stored — mirroring nothing (needsBaseline)',
        );
      } else if (pair.mirrorSimkl) {
        const baseline = pair.watchTogetherBaseline;
        const baselineEpisodeCount = Object.values(baseline.shows).reduce(
          (total, episodes) => total + episodes.length,
          0,
        );
        dbg(
          mirrorScope,
          `baseline present — capturedAt ${baseline.capturedAt}, ${baseline.movies.length} movie(s), ${baselineEpisodeCount} episode(s)`,
        );
        const mirrorWatched = subtractWatchTogetherBaseline(
          watched,
          pair.watchTogetherBaseline,
        );
        // Log what the baseline removed, per item, before the mirror diff.
        for (const imdb of watched.movies.keys()) {
          if (!mirrorWatched.movies.has(imdb)) {
            dbg(mirrorScope, `excluded (in baseline) ${imdb}`);
          }
        }
        for (const [imdb, show] of watched.shows.entries()) {
          const kept = mirrorWatched.shows.get(imdb)?.episodes;
          for (const key of show.episodes) {
            if (!kept || !kept.has(key)) {
              const [season, episode] = key.split(':');
              dbg(
                mirrorScope,
                `excluded (in baseline) ${imdb} S${season}E${episode}`,
              );
            }
          }
        }
        const candidateEpisodeCount = [...mirrorWatched.shows.values()].reduce(
          (total, show) => total + show.episodes.size,
          0,
        );
        dbg(
          mirrorScope,
          `mirror candidates after baseline — ${mirrorWatched.movies.size} movie(s), ${candidateEpisodeCount} episode(s)`,
        );
        const mirror = await syncTarget({
          pairName: pair.name,
          targetKey: 'mirrorSimkl',
          auth: pair.mirrorSimkl,
          watched: mirrorWatched,
          secret,
          dataDir,
          log,
          dbg,
          mirror: true,
        });
        entry.mirrorAddedMovies = mirror.addedMovies;
        entry.mirrorAddedEpisodes = mirror.addedEpisodes;
      } else {
        dbg(
          mirrorScope,
          'Watch Together is on but no mirror Simkl account is connected — mirroring nothing',
        );
      }
    }

    entry.lastSuccessAt = new Date().toISOString();
    log.log(
      `[reconciler] ${pair.name}: run complete — added ${entry.addedMovies} movie(s), ${entry.addedEpisodes} episode(s)` +
        (entry.needsBaseline
          ? '; mirror skipped (no Watch Together baseline)'
          : pair.watchTogether && pair.mirrorSimkl
            ? `; mirror added ${entry.mirrorAddedMovies} movie(s), ${entry.mirrorAddedEpisodes} episode(s)`
            : '') +
        (entry.skipped ? `; ${entry.skipped} watched item(s) skipped (unresolvable)` : ''),
    );
    dbg(
      pairScope,
      `run complete — added ${entry.addedMovies} movie(s), ${entry.addedEpisodes} episode(s)` +
        (pair.watchTogether && pair.mirrorSimkl && !entry.needsBaseline
          ? `; mirror added ${entry.mirrorAddedMovies} movie(s), ${entry.mirrorAddedEpisodes} episode(s)`
          : '') +
        (entry.needsBaseline ? '; mirror skipped (no baseline)' : '') +
        (entry.skipped ? `; ${entry.skipped} skipped` : ''),
    );
  } catch (e) {
    entry.lastError = e.message;
    entry.needsReauth = !!e.needsReauth;
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      entry.needsReauth = true;
    }
    log.error(`[reconciler] ${pair.name}: run failed — ${e.message}`);
    dbg(pairScope, `run failed — ${e.stack || e.message}`);
    if (entry.needsReauth) {
      dbg(pairScope, 'needsReauth — Simkl must be reconnected for this pair');
    }
  }

  return entry;
}

export async function runReconcilerOnce({ secret, dataDir = getDataDir(), log = console } = {}) {
  const dbg = createDebugLogger(dataDir);
  if (!secret) {
    log.error(
      '[reconciler] PRIVATE_ENCRYPTION_KEY is not set; cannot read saved pairs. Skipping run.',
    );
    dbg(
      'reconciler',
      'run skipped — PRIVATE_ENCRYPTION_KEY is not set; cannot read saved pairs',
    );
    return null;
  }

  let pairs;
  try {
    pairs = loadPairs(secret, dataDir);
  } catch (e) {
    log.error(
      `[reconciler] Could not decrypt the pairs file (${e.message}). If PRIVATE_ENCRYPTION_KEY changed, saved pairs must be re-saved from the configure page.`,
    );
    dbg('reconciler', `run skipped — could not decrypt the pairs file: ${e.message}`);
    return null;
  }

  dbg(
    'reconciler',
    `run started — ${pairs.length} pair(s) loaded${pairs.length ? `: ${pairs.map((pair) => pair.name).join(', ')}` : ''}`,
  );

  const previous = readStatus(dataDir);
  const status = { updatedAt: null, pairs: { ...previous.pairs } };

  if (pairs.length === 0) {
    log.log('[reconciler] No saved pairs yet; nothing to reconcile.');
  }

  for (const pair of pairs) {
    const entry = await reconcilePair(pair, { secret, dataDir, log });
    if (!entry.lastSuccessAt && previous.pairs[pair.name]?.lastSuccessAt) {
      entry.lastSuccessAt = previous.pairs[pair.name].lastSuccessAt;
    }
    status.pairs[pair.name] = entry;
  }

  writeStatus(status, dataDir);
  dbg(
    'reconciler',
    `run finished — status written for ${pairs.length} pair(s)`,
  );
  return status;
}

export function startReconciler() {
  const secret = process.env.PRIVATE_ENCRYPTION_KEY;
  const dataDir = getDataDir();
  const intervalMinutes = Math.max(
    1,
    parseInt(process.env.RECONCILE_INTERVAL_MINUTES || '30', 10) || 30,
  );

  const dbg = createDebugLogger(dataDir);
  console.log(
    `[reconciler] Starting. Data dir: ${dataDir}. Interval: ${intervalMinutes} minute(s).`,
  );
  dbg(
    'reconciler',
    `reconciler starting — data dir ${dataDir}, interval ${intervalMinutes} minute(s)`,
  );

  let running = false;
  const tick = async () => {
    if (running) {
      console.log('[reconciler] Previous run still in progress; skipping.');
      dbg('reconciler', 'previous run still in progress; skipping this tick');
      return;
    }
    running = true;
    try {
      await runReconcilerOnce({ secret, dataDir });
    } catch (e) {
      console.error(`[reconciler] Unexpected run failure: ${e.message}`);
      dbg('reconciler', `unexpected run failure — ${e.stack || e.message}`);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(tick, intervalMinutes * 60 * 1000);
}
