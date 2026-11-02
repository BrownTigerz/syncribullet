// Watch Together starting-point snapshots.
//
// Watch Together is prospective only: when it is switched on, the server
// records the pair's current Stremio watched set as a baseline. The mirror
// pass later syncs (current watched set - baseline) to the mirror Simkl
// account, so nothing watched before the switch-on moment is copied.
//
// The baseline uses the reconciler's own watched-state scheme:
// - movies: IMDb ids, as in watched.movies Map keys
// - shows: IMDb id -> episode keys in watched.shows, each "season:episode"

import { extractWatched, fetchStremioLibrary } from './stremio.mjs';

export class WatchTogetherBaselineError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'WatchTogetherBaselineError';
    if (cause) {
      this.cause = cause;
    }
  }
}

function compareEpisodeKeys(a, b) {
  const [aSeason, aEpisode] = String(a).split(':').map((n) => parseInt(n, 10));
  const [bSeason, bEpisode] = String(b).split(':').map((n) => parseInt(n, 10));
  if (Number.isFinite(aSeason) && Number.isFinite(bSeason) && aSeason !== bSeason) {
    return aSeason - bSeason;
  }
  if (Number.isFinite(aEpisode) && Number.isFinite(bEpisode)) {
    return aEpisode - bEpisode;
  }
  return String(a).localeCompare(String(b));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isWatchTogetherBaseline(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.capturedAt !== 'string' || !value.capturedAt) {
    return false;
  }
  if (!Array.isArray(value.movies)) {
    return false;
  }
  if (!isPlainObject(value.shows)) {
    return false;
  }
  return Object.values(value.shows).every((episodes) => Array.isArray(episodes));
}

/** Convert an extractWatched() result into the stored baseline shape. */
export function createWatchTogetherBaseline(
  watched,
  capturedAt = new Date().toISOString(),
) {
  const shows = {};
  for (const imdb of [...watched.shows.keys()].sort()) {
    shows[imdb] = [...watched.shows.get(imdb).episodes].sort(compareEpisodeKeys);
  }
  return {
    version: 1,
    capturedAt,
    movies: [...watched.movies.keys()].sort(),
    shows,
  };
}

/**
 * Return the subset of `watched` that is not in `baseline`.
 * Throws when the baseline is missing or malformed: callers must treat
 * that as "mirror nothing", never as "mirror everything".
 */
export function subtractWatchTogetherBaseline(watched, baseline) {
  if (!isWatchTogetherBaseline(baseline)) {
    throw new WatchTogetherBaselineError(
      'Watch Together is on but no valid starting-point baseline is stored',
    );
  }

  const baselineMovies = new Set(baseline.movies);
  const baselineShows = new Map(
    Object.entries(baseline.shows).map(([imdb, episodes]) => [
      imdb,
      new Set(episodes),
    ]),
  );

  const movies = new Map();
  for (const [imdb, movie] of watched.movies.entries()) {
    if (!baselineMovies.has(imdb)) {
      movies.set(imdb, movie);
    }
  }

  const shows = new Map();
  for (const [imdb, show] of watched.shows.entries()) {
    const baselineEpisodes = baselineShows.get(imdb);
    const episodes = new Set(
      [...show.episodes].filter(
        (episode) => !baselineEpisodes || !baselineEpisodes.has(episode),
      ),
    );
    if (episodes.size > 0) {
      shows.set(imdb, { ...show, episodes });
    }
  }

  return { movies, shows, skipped: watched.skipped || 0 };
}

/**
 * Fetch the pair's full current watched set and snapshot it.
 * A partial snapshot is treated as failure: if any watched item is
 * unresolved (it might become resolvable later), storing the baseline
 * could cause that old item to be mirrored once it resolves. Permanently
 * out-of-scope items (non-IMDb ids) are skipped by extraction and do not
 * block the snapshot — they can never enter the mirror diff.
 */
export async function captureWatchTogetherBaseline(
  stremioAuthKey,
  {
    fetchLibrary = fetchStremioLibrary,
    extract = extractWatched,
    log = console,
    capturedAt = new Date().toISOString(),
  } = {},
) {
  let watched;
  try {
    const libraryItems = await fetchLibrary(stremioAuthKey);
    watched = await extract(libraryItems, log);
  } catch (e) {
    throw new WatchTogetherBaselineError(
      `Could not read the current Stremio watched list to set the Watch Together starting point: ${e.message}`,
      e,
    );
  }

  if (!watched || !watched.movies || !watched.shows) {
    throw new WatchTogetherBaselineError(
      'Could not read the current Stremio watched list to set the Watch Together starting point: unexpected watched-state shape',
    );
  }
  const incompleteCount =
    typeof watched.unresolved === 'number'
      ? watched.unresolved
      : watched.skipped || 0;
  if (incompleteCount) {
    throw new WatchTogetherBaselineError(
      `Could not set the Watch Together starting point: ${incompleteCount} watched item(s) could not be resolved, so the starting point would be incomplete`,
    );
  }

  return createWatchTogetherBaseline(watched, capturedAt);
}

/**
 * Save-flow rule:
 * - Watch Together off: no baseline (any old baseline is dropped).
 * - Already on with a valid baseline: keep that baseline exactly; a plain
 *   re-save must never move the starting point forward.
 * - Turning on, or on without a valid baseline: capture a new baseline.
 */
export async function resolveWatchTogetherBaseline({
  existingPair,
  watchTogether,
  stremioAuthKey,
  captureBaseline = captureWatchTogetherBaseline,
}) {
  if (!watchTogether) {
    return null;
  }
  if (
    existingPair?.watchTogether &&
    isWatchTogetherBaseline(existingPair.watchTogetherBaseline)
  ) {
    return existingPair.watchTogetherBaseline;
  }
  return captureBaseline(stremioAuthKey);
}
