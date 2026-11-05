// Headless Simkl API access for the reconciler.
// Same endpoints and headers the app already uses
// (src/utils/receivers/simkl/api/headers.ts, src/utils/importers/simkl/api):
//   POST /sync/history          (the reconciler's only write — add-only)
//   POST /sync/history/remove   (ONLY from the manual, per-item undo in
//                                remove-history.mjs — never automatic)
//   GET  /sync/all-items/       (full library read, per-episode detail)
//   POST /oauth2/token          (AUTH V2 refresh grant)
// No add-to-list call exists in this file by design.

import { HttpError } from './stremio.mjs';

const API = 'https://api.simkl.com';
const USER_AGENT = 'syncribullet/2.0';

export function simklHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + auth.access_token,
    'simkl-api-key': auth.client_id,
    'User-Agent': USER_AGENT,
  };
}

async function throwOnError(response, what) {
  if (response.status === 401) {
    throw new HttpError(401, `${what}: Simkl returned 401 (token rejected)`);
  }
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${what}: Simkl returned ${response.status}`,
    );
  }
}

/**
 * Full library read with per-episode watched detail.
 * extended=full + include_all_episodes=original makes show entries carry
 * seasons[].episodes[] (also for completed items) — see docs/SIMKL_AUTH.md.
 */
export async function fetchSimklLibrary(auth) {
  const response = await fetch(
    `${API}/sync/all-items/?extended=full&include_all_episodes=original`,
    { method: 'GET', headers: simklHeaders(auth) },
  );
  await throwOnError(response, 'GET /sync/all-items');
  const data = await response.json();
  return parseSimklLibrary(data || {});
}

function parseSxE(lastWatched) {
  if (!lastWatched || typeof lastWatched !== 'string') {
    return null;
  }
  const match = lastWatched.match(/S(\d+)E(\d+)/i);
  if (!match) {
    return null;
  }
  return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
}

/**
 * Reduce a Simkl library response to watched state:
 * {
 *   movies: Set<imdbId>,
 *   shows: Map<imdbId, {
 *     episodes: Set<'season:episode'>,
 *     fullyWatched: boolean,              // status completed
 *     lastWatched: {season, episode}|null // fallback when no episode rows
 *   }>
 * }
 */
export function parseSimklLibrary(data) {
  const movies = new Set();
  const shows = new Map();

  for (const entry of data.movies || []) {
    const imdb = entry?.movie?.ids?.imdb;
    if (!imdb) {
      continue;
    }
    if (entry.status === 'completed' || entry.last_watched_at) {
      movies.add(imdb);
    }
  }

  const showEntries = [...(data.shows || []), ...(data.anime || [])];
  for (const entry of showEntries) {
    const imdb = entry?.show?.ids?.imdb;
    if (!imdb) {
      continue;
    }
    const episodes = new Set();
    for (const season of entry.seasons || []) {
      for (const episode of season.episodes || []) {
        if (episode && episode.watched) {
          episodes.add(`${season.number}:${episode.number}`);
        }
      }
    }
    shows.set(imdb, {
      episodes,
      fullyWatched: entry.status === 'completed',
      lastWatched: parseSxE(entry.last_watched),
    });
  }

  return { movies, shows };
}

/** Is one Stremio episode already present in the Simkl watched state? */
export function simklHasEpisode(showState, season, episode) {
  if (!showState) {
    return false;
  }
  if (showState.episodes.has(`${season}:${episode}`)) {
    return true;
  }
  if (showState.fullyWatched) {
    return true;
  }
  const lw = showState.lastWatched;
  if (lw && showState.episodes.size === 0) {
    return (
      season < lw.season || (season === lw.season && episode <= lw.episode)
    );
  }
  return false;
}

/**
 * Simkl's /sync/history response reports what it actually marked in an
 * `added` object ({ movies, shows, episodes } counts) — the server's
 * own count of items affected, which can differ from what was sent
 * (an already-watched item is sent but adds nothing). Parse it
 * defensively: a field that is missing or not a finite, non-negative
 * number is unknown (null), and a response with no usable counts at
 * all yields null. Never throws.
 */
export function parseAddedCounts(data) {
  const added = data?.added;
  if (!added || typeof added !== 'object') {
    return null;
  }
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const parsed = {
    movies: count(added.movies),
    shows: count(added.shows),
    episodes: count(added.episodes),
  };
  if (
    parsed.movies === null &&
    parsed.shows === null &&
    parsed.episodes === null
  ) {
    return null;
  }
  return parsed;
}

/**
 * One-line rendering of confirmed counts for the debug log, e.g.
 * "Simkl added 1 episode(s)" or "Simkl added 2 movie(s), 3 episode(s)".
 * Movies and episodes are the units a reader reconciles against the
 * sent items; the shows count (show entries touched) is not rendered.
 * A known zero is reported when nothing was added at all, so a re-post
 * of an already-watched item reads as confirmed-zero rather than
 * silence. Returns null when there is nothing meaningful to report,
 * so callers keep their existing log line unchanged.
 */
export function formatAddedCounts(added) {
  if (!added) {
    return null;
  }
  const counts = [];
  if (typeof added.movies === 'number' && Number.isFinite(added.movies)) {
    counts.push({ label: 'movie(s)', value: added.movies });
  }
  if (typeof added.episodes === 'number' && Number.isFinite(added.episodes)) {
    counts.push({ label: 'episode(s)', value: added.episodes });
  }
  if (counts.length === 0) {
    return null;
  }
  const positive = counts.filter((entry) => entry.value > 0);
  const shown = positive.length > 0 ? positive : counts;
  return `Simkl added ${shown
    .map((entry) => `${entry.value} ${entry.label}`)
    .join(', ')}`;
}

/**
 * POST /sync/history with { movies, shows } in the same shape the stock
 * importer builds. Chunked so a large first run stays in modest requests.
 * The optional onPost callback fires after each chunk with
 * { movies, shows, status, added } (item counts in the chunk, HTTP
 * status, and Simkl's confirmed `added` counts for that chunk — see
 * parseAddedCounts; null when the response carried none) so callers
 * can record the write in the debug log.
 */
export async function postHistory(auth, payload, onPost) {
  const results = { movies: 0, shows: 0 };
  const movieChunks = chunk(payload.movies, 100);
  const showChunks = chunk(payload.shows, 50);
  for (const movies of movieChunks) {
    const { data, status } = await postHistoryChunk(auth, {
      movies,
      shows: [],
    });
    if (onPost) {
      onPost({
        movies: movies.length,
        shows: 0,
        status,
        added: parseAddedCounts(data),
      });
    }
    results.movies += movies.length;
  }
  for (const shows of showChunks) {
    const { data, status } = await postHistoryChunk(auth, {
      movies: [],
      shows,
    });
    if (onPost) {
      onPost({
        movies: 0,
        shows: shows.length,
        status,
        added: parseAddedCounts(data),
      });
    }
    results.shows += shows.length;
  }
  return results;
}

async function postHistoryChunk(auth, body) {
  const response = await fetch(`${API}/sync/history/`, {
    method: 'POST',
    headers: simklHeaders(auth),
    body: JSON.stringify(body),
  });
  await throwOnError(response, 'POST /sync/history');
  const data = await response.json().catch(() => ({}));
  return { data, status: response.status };
}

/**
 * Simkl's /sync/history/remove response reports what it actually
 * unmarked in a `deleted` object ({ movies, shows, episodes } counts)
 * — the mirror image of the `added` object on /sync/history. Parse it
 * with the same defensive rules as parseAddedCounts: a missing or
 * non-numeric field is unknown (null), a response with no usable
 * counts at all yields null. Never throws. (A `removed` object is
 * accepted as a fallback key, in case the API ever renames it.)
 */
export function parseRemovedCounts(data) {
  const deleted =
    data?.deleted && typeof data.deleted === 'object'
      ? data.deleted
      : data?.removed && typeof data.removed === 'object'
        ? data.removed
        : null;
  if (!deleted) {
    return null;
  }
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const parsed = {
    movies: count(deleted.movies),
    shows: count(deleted.shows),
    episodes: count(deleted.episodes),
  };
  if (
    parsed.movies === null &&
    parsed.shows === null &&
    parsed.episodes === null
  ) {
    return null;
  }
  return parsed;
}

/**
 * One-line rendering of confirmed removal counts for the debug log,
 * e.g. "Simkl removed 1 episode(s)" — the counterpart of
 * formatAddedCounts, with the same rules (movies and episodes
 * rendered, a known zero reported when nothing was removed).
 */
export function formatRemovedCounts(removed) {
  if (!removed) {
    return null;
  }
  const counts = [];
  if (typeof removed.movies === 'number' && Number.isFinite(removed.movies)) {
    counts.push({ label: 'movie(s)', value: removed.movies });
  }
  if (
    typeof removed.episodes === 'number' &&
    Number.isFinite(removed.episodes)
  ) {
    counts.push({ label: 'episode(s)', value: removed.episodes });
  }
  if (counts.length === 0) {
    return null;
  }
  const positive = counts.filter((entry) => entry.value > 0);
  const shown = positive.length > 0 ? positive : counts;
  return `Simkl removed ${shown
    .map((entry) => `${entry.value} ${entry.label}`)
    .join(', ')}`;
}

/**
 * POST /sync/history/remove with one single-item payload (the exact
 * shape postHistory sends — see remove-history.mjs). This is the one
 * deliberate exception to the build's add-only rule: it exists solely
 * for the manual, per-item undo on the configure page and is never
 * called by the reconciler or any automatic path.
 * Returns { data, status }; throws HttpError like postHistoryChunk.
 */
export async function removeFromHistory(auth, payload) {
  const response = await fetch(`${API}/sync/history/remove`, {
    method: 'POST',
    headers: simklHeaders(auth),
    body: JSON.stringify(payload),
  });
  await throwOnError(response, 'POST /sync/history/remove');
  const data = await response.json().catch(() => ({}));
  return { data, status: response.status };
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

/**
 * AUTH V2 refresh grant. Returns a new auth object; the refresh token is
 * non-rotating (same string comes back), the previous access token stops
 * working immediately. See docs/SIMKL_AUTH.md.
 */
export async function refreshSimklAuth(auth) {
  if (!auth.refresh_token) {
    throw new Error('No refresh token stored for this Simkl connection');
  }
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: auth.client_id,
      refresh_token: auth.refresh_token,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new HttpError(
      response.status,
      `Simkl token refresh failed: ${data.error || response.status}`,
    );
  }
  return {
    access_token: data.access_token,
    client_id: auth.client_id,
    refresh_token: data.refresh_token || auth.refresh_token,
    expires_at: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
  };
}
