// Headless Simkl API access for the reconciler.
// Same endpoints and headers the app already uses
// (src/utils/receivers/simkl/api/headers.ts, src/utils/importers/simkl/api):
//   POST /sync/history          (the only write — add-only)
//   GET  /sync/all-items/       (full library read, per-episode detail)
//   POST /oauth2/token          (AUTH V2 refresh grant)
// No delete/remove or add-to-list call exists in this file by design.

import { HttpError } from './stremio.mjs';

const API = 'https://api.simkl.com';
const USER_AGENT = 'syncribullet/2.0';

export function simklHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    Authorization: <redacted>
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
 * POST /sync/history with { movies, shows } in the same shape the stock
 * importer builds. Chunked so a large first run stays in modest requests.
 */
export async function postHistory(auth, payload) {
  const results = { movies: 0, shows: 0 };
  const movieChunks = chunk(payload.movies, 100);
  const showChunks = chunk(payload.shows, 50);
  for (const movies of movieChunks) {
    await postHistoryChunk(auth, { movies, shows: [] });
    results.movies += movies.length;
  }
  for (const shows of showChunks) {
    await postHistoryChunk(auth, { movies: [], shows });
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
  return response.json().catch(() => ({}));
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
