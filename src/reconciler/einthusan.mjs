// Einthusan → Simkl marking — the server side of the Brave extension
// in ~/workspace/einthusan-simkl (delivered as its own zip; this module
// ships with the SimklStremio server build like every other reconciler
// module).
//
// What it does, and nothing more:
// - Searches Simkl movies by title for the extension's confirm panel
//   (GET https://api.simkl.com/search/movie with the pair's Simkl
//   client_id as the api key — the same client_id the pair already
//   holds; no new credentials).
// - Stores the movie TK confirms for one Einthusan page in
//   <dataDir>/einthusan-matches.json, keyed by the Einthusan page's
//   stable site id (the short code in /movie/watch/<id>/). Plain JSON:
//   the file holds only site ids and Simkl/IMDb/TMDB ids — no tokens,
//   so unlike pairs.json it needs no encryption.
// - Marks a saved match watched on TK's own Simkl, through
//   POST /sync/history, after checking his library so an
//   already-watched movie is never posted twice.
// - Solo / Together is the EXTENSION's choice, saved per movie on
//   the match record (`watchTogether`). A Together mark also posts
//   the movie to the pair's stored mirror account (pair.mirrorSimkl)
//   after checking the mirror library. This path never consults the
//   Stremio-side Watch Together machinery — pair.watchTogether, the
//   WATCH_TOGETHER .env override, and the Watch Together baseline
//   are neither read nor altered here; the extension is separate
//   from Stremio by TK's decision. A mirror failure never fails the
//   own mark.
//
// Driven only by POST/GET /api/einthusan (see
// src/routes/api/einthusan) from TK's own extension on his LAN. Like
// /api/pairs and /api/remove-history the route has no login of its
// own — LAN only, never expose this server publicly.
//
// Token lifecycle matches the other writers (remove-history.mjs):
// proactive refresh inside the token's last day, one refresh-and-
// retry on a 401, refreshed tokens persisted through updatePairAuth.
//
// Secrecy: no tokens or credentials are logged — pair names, titles,
// ids, HTTP status codes and Simkl's confirmed counts only, through
// the debug log under scope `einthusan`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeDebugLog } from './debug-log.mjs';
import { getDataDir, loadPairs, updatePairAuth } from './pairs-store.mjs';
import {
  fetchSimklLibrary,
  formatAddedCounts,
  parseAddedCounts,
  postHistory,
  refreshSimklAuth,
  simklHeaders,
} from './simkl.mjs';
import { HttpError } from './stremio.mjs';

const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 10;
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const IMDB_ID = /^tt\d+$/;

/** A client/upstream failure with the HTTP status the route returns. */
export class EinthusanError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'EinthusanError';
    this.status = status;
  }
}

function badRequest(message) {
  return new EinthusanError(400, message);
}

// ---------------------------------------------------------------------------
// Saved-match store — <dataDir>/einthusan-matches.json
// Shape: { version: 1, matches: { [siteId]: MatchRecord } }
// MatchRecord: {
//   siteId, pageTitle, pageYear, pageLanguage,
//   title, year, simkl (number|null), imdb (string|null),
//   tmdb (number|null), poster (string|null),
//   watchTogether (boolean — the extension's Solo/Together choice
//   for this movie; absent/false = Solo),
//   savedAt (ISO), markedAt (ISO|null)
// }
// ---------------------------------------------------------------------------

export function einthusanMatchesFilePath(dataDir = getDataDir()) {
  return join(dataDir, 'einthusan-matches.json');
}

export function loadEinthusanMatches(dataDir = getDataDir()) {
  const file = einthusanMatchesFilePath(dataDir);
  if (!existsSync(file)) {
    return {};
  }
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc && typeof doc === 'object' && doc.matches && typeof doc.matches === 'object') {
      return doc.matches;
    }
  } catch {
    // A corrupt store reads as empty; the next save rewrites it.
  }
  return {};
}

export function saveEinthusanMatches(matches, dataDir = getDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    einthusanMatchesFilePath(dataDir),
    JSON.stringify({ version: 1, matches }, null, 2),
    'utf8',
  );
}

export function validateSiteId(siteId) {
  const value = typeof siteId === 'string' ? siteId.trim() : '';
  if (!SITE_ID.test(value)) {
    throw badRequest('An Einthusan site id is required (the code in /movie/watch/<id>/)');
  }
  return value;
}

/**
 * Validate and normalize a match the extension wants saved. The
 * extension sends the Simkl candidate TK picked, plus what it read
 * off the Einthusan page. At least one of simkl / imdb must be a
 * usable id — a match with no id can never be marked.
 */
export function sanitizeEinthusanMatch(input, siteId) {
  if (!input || typeof input !== 'object') {
    throw badRequest('A match object is required');
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw badRequest('The matched movie needs a title');
  }
  const year =
    typeof input.year === 'number' && Number.isInteger(input.year)
      ? input.year
      : typeof input.year === 'string' && /^\d{4}$/.test(input.year.trim())
        ? parseInt(input.year.trim(), 10)
        : null;
  const simkl =
    typeof input.simkl === 'number' && Number.isInteger(input.simkl) && input.simkl > 0
      ? input.simkl
      : typeof input.simkl === 'string' && /^\d+$/.test(input.simkl.trim())
        ? parseInt(input.simkl.trim(), 10)
        : null;
  const imdb =
    typeof input.imdb === 'string' && IMDB_ID.test(input.imdb.trim())
      ? input.imdb.trim()
      : null;
  const tmdb =
    typeof input.tmdb === 'number' && Number.isInteger(input.tmdb) && input.tmdb > 0
      ? input.tmdb
      : typeof input.tmdb === 'string' && /^\d+$/.test(input.tmdb.trim())
        ? parseInt(input.tmdb.trim(), 10)
        : null;
  if (!simkl && !imdb) {
    throw badRequest('The matched movie has no Simkl or IMDb id — it cannot be marked');
  }
  const text = (value, max) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  return {
    siteId,
    pageTitle: text(input.pageTitle, 200),
    pageYear:
      typeof input.pageYear === 'number' && Number.isInteger(input.pageYear)
        ? input.pageYear
        : null,
    pageLanguage: text(input.pageLanguage, 40),
    title,
    year,
    simkl,
    imdb,
    tmdb,
    poster: text(input.poster, 500),
    // Only a literal true counts — anything else is Solo.
    watchTogether: input.watchTogether === true,
    savedAt: new Date().toISOString(),
    markedAt: null,
  };
}

export function getEinthusanMatch(siteId, dataDir = getDataDir()) {
  const id = validateSiteId(siteId);
  return loadEinthusanMatches(dataDir)[id] || null;
}

export function saveEinthusanMatch(input, siteId, dataDir = getDataDir()) {
  const id = validateSiteId(siteId);
  const record = sanitizeEinthusanMatch(input, id);
  const matches = loadEinthusanMatches(dataDir);
  // Re-picking a different movie for the same page clears the old
  // marked state; re-saving the same movie keeps it.
  const previous = matches[id];
  if (previous && previous.simkl === record.simkl && previous.imdb === record.imdb) {
    record.markedAt = previous.markedAt || null;
    record.savedAt = previous.savedAt || record.savedAt;
  }
  matches[id] = record;
  saveEinthusanMatches(matches, dataDir);
  return record;
}

export function clearEinthusanMatch(siteId, dataDir = getDataDir()) {
  const id = validateSiteId(siteId);
  const matches = loadEinthusanMatches(dataDir);
  if (!matches[id]) {
    return false;
  }
  delete matches[id];
  saveEinthusanMatches(matches, dataDir);
  return true;
}

// ---------------------------------------------------------------------------
// Simkl movie search
// ---------------------------------------------------------------------------

/**
 * Simkl search returns poster as a path fragment (e.g. "ab/123_w.jpg");
 * posters are served from https://simkl.in/posters/<fragment>. Pass
 * full URLs through untouched.
 */
export function simklPosterUrl(poster) {
  if (typeof poster !== 'string' || !poster.trim()) {
    return null;
  }
  const value = poster.trim();
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://simkl.in/posters/${value.replace(/^\/+/, '')}`;
}

/**
 * Reduce a Simkl /search/movie response to the candidate shape the
 * extension renders: { title, year, ids: { simkl, imdb, tmdb },
 * poster }. Defensive like parseSimklLibrary: entries without a
 * title or any usable id are dropped. The ids block arrives with
 * either `simkl_id` or `simkl` depending on the endpoint; both are
 * accepted. Never throws.
 */
export function parseSimklSearchResults(data) {
  const list = Array.isArray(data) ? data : [];
  const candidates = [];
  for (const entry of list) {
    const movie = entry?.movie && typeof entry.movie === 'object' ? entry.movie : entry;
    if (!movie || typeof movie !== 'object') {
      continue;
    }
    const title = typeof movie.title === 'string' ? movie.title.trim() : '';
    const ids = movie.ids && typeof movie.ids === 'object' ? movie.ids : {};
    const simklRaw = ids.simkl_id ?? ids.simkl;
    const simkl =
      typeof simklRaw === 'number' && Number.isInteger(simklRaw) && simklRaw > 0
        ? simklRaw
        : typeof simklRaw === 'string' && /^\d+$/.test(simklRaw)
          ? parseInt(simklRaw, 10)
          : null;
    const imdb =
      typeof ids.imdb === 'string' && IMDB_ID.test(ids.imdb) ? ids.imdb : null;
    const tmdb =
      typeof ids.tmdb === 'number' && Number.isInteger(ids.tmdb) && ids.tmdb > 0
        ? ids.tmdb
        : typeof ids.tmdb === 'string' && /^\d+$/.test(ids.tmdb)
          ? parseInt(ids.tmdb, 10)
          : null;
    if (!title || (!simkl && !imdb)) {
      continue;
    }
    candidates.push({
      title,
      year:
        typeof movie.year === 'number' && Number.isInteger(movie.year)
          ? movie.year
          : null,
      ids: { simkl, imdb, tmdb },
      poster: simklPosterUrl(movie.poster),
    });
  }
  return candidates;
}

/** GET /search/movie?q=…&extended=full with the pair's client_id. */
export async function searchSimklMovies(auth, query) {
  const url =
    `https://api.simkl.com/search/movie?q=${encodeURIComponent(query)}` +
    `&extended=full&limit=${SEARCH_LIMIT}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: simklHeaders(auth),
  });
  if (response.status === 401) {
    throw new HttpError(401, 'Simkl search: Simkl returned 401 (token rejected)');
  }
  if (!response.ok) {
    throw new HttpError(response.status, `Simkl search: Simkl returned ${response.status}`);
  }
  const data = await response.json().catch(() => []);
  return parseSimklSearchResults(data);
}

// ---------------------------------------------------------------------------
// Pair resolution + token lifecycle (same rules as remove-history.mjs)
// ---------------------------------------------------------------------------

function resolvePair({ pairName, secret, dataDir, loadPairsFn }) {
  const name = typeof pairName === 'string' ? pairName.trim() : '';
  if (!name) {
    throw badRequest('A pair name is required');
  }
  if (!secret) {
    throw new EinthusanError(500, 'PRIVATE_ENCRYPTION_KEY is not set on the server');
  }
  const pairs = loadPairsFn(secret, dataDir);
  const pair = (pairs || []).find((entry) => entry.name === name);
  if (!pair) {
    throw badRequest(`No saved pair named "${name}"`);
  }
  const auth = pair.simkl;
  if (!auth?.access_token || !auth?.client_id) {
    throw badRequest(`Pair "${name}" has no Simkl account connected`);
  }
  return { pair, name };
}

/**
 * Run `operation(auth)` with one of the pair's stored Simkl accounts:
 * proactive refresh inside the last day, one refresh-and-retry on a
 * 401, refreshed tokens persisted under the same target. Mirrors
 * removeHistoryItem's lifecycle exactly. `target` is 'simkl' (the
 * pair's own account, the default) or 'mirrorSimkl' (the stored
 * mirror account, used only by the extension's Together marks).
 */
async function withPairAuth({
  pairName,
  secret,
  dataDir,
  loadPairsFn = loadPairs,
  refreshAuthFn = refreshSimklAuth,
  persistAuthFn = updatePairAuth,
  dbg,
  operation,
  target = 'simkl',
}) {
  let name;
  if (target === 'simkl') {
    ({ name } = resolvePair({ pairName, secret, dataDir, loadPairsFn }));
  } else {
    name = typeof pairName === 'string' ? pairName.trim() : '';
    if (!name) {
      throw badRequest('A pair name is required');
    }
    if (!secret) {
      throw new EinthusanError(500, 'PRIVATE_ENCRYPTION_KEY is not set on the server');
    }
  }
  const pairs = loadPairsFn(secret, dataDir);
  const pair = (pairs || []).find((entry) => entry.name === name);
  let auth = target === 'mirrorSimkl' ? pair?.mirrorSimkl : pair?.simkl;
  if (!auth?.access_token || !auth?.client_id) {
    throw badRequest(
      `Pair "${name}" has no ${target === 'mirrorSimkl' ? 'mirror ' : ''}Simkl account connected`,
    );
  }

  const persist = (newAuth) => {
    auth = newAuth;
    try {
      persistAuthFn(name, target, newAuth, secret, dataDir);
    } catch (e) {
      dbg(`token refresh could not be saved for pair ${name} — ${e.message}`);
    }
  };

  if (
    auth.refresh_token &&
    auth.expires_at &&
    auth.expires_at - Date.now() < REFRESH_WINDOW_MS
  ) {
    try {
      persist(await refreshAuthFn(auth));
    } catch (e) {
      dbg(`token refresh failed for pair ${name} — ${e.message}; trying the current token`);
    }
  }

  try {
    return await operation(auth);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) {
      throw e;
    }
    if (!auth.refresh_token) {
      throw new EinthusanError(
        502,
        'Simkl returned 401 and no refresh token is stored. Reconnect Simkl for this pair.',
      );
    }
    try {
      persist(await refreshAuthFn(auth));
    } catch (refreshError) {
      throw new EinthusanError(
        502,
        `Simkl token refresh failed: ${refreshError.message}. Reconnect Simkl for this pair.`,
      );
    }
    try {
      return await operation(auth);
    } catch (retryError) {
      if (retryError instanceof HttpError && retryError.status === 401) {
        throw new EinthusanError(
          502,
          'Simkl still returned 401 after a token refresh. Reconnect Simkl for this pair.',
        );
      }
      throw retryError;
    }
  }
}

// ---------------------------------------------------------------------------
// Route-level operations (injection seams are for tests)
// ---------------------------------------------------------------------------

/** Search Simkl movies by title for one pair's extension panel. */
export async function einthusanSearch({
  pairName,
  query,
  secret,
  dataDir = getDataDir(),
  loadPairsFn = loadPairs,
  searchFn = searchSimklMovies,
  refreshAuthFn = refreshSimklAuth,
  persistAuthFn = updatePairAuth,
  dbg = (message) => writeDebugLog('einthusan', message, dataDir),
} = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) {
    throw badRequest('A search title is required');
  }
  const candidates = await withPairAuth({
    pairName,
    secret,
    dataDir,
    loadPairsFn,
    refreshAuthFn,
    persistAuthFn,
    dbg,
    operation: (auth) => searchFn(auth, q),
  }).catch((e) => {
    if (e instanceof EinthusanError) {
      throw e;
    }
    throw new EinthusanError(502, `Simkl search failed: ${e.message}`);
  });
  return { ok: true, query: q, candidates };
}

/** Save the confirmed match for one Einthusan page. */
export function einthusanSaveMatch({ siteId, match, dataDir = getDataDir() } = {}) {
  const record = saveEinthusanMatch(match, siteId, dataDir);
  return { ok: true, match: record };
}

/** The saved match for one Einthusan page, or null. */
export function einthusanGetMatch({ siteId, dataDir = getDataDir() } = {}) {
  return { ok: true, match: getEinthusanMatch(siteId, dataDir) };
}

/** Clear the saved match for one Einthusan page. */
export function einthusanClearMatch({ siteId, dataDir = getDataDir() } = {}) {
  return { ok: true, cleared: clearEinthusanMatch(siteId, dataDir) };
}

function matchIdsLabel(match) {
  const parts = [];
  if (match.imdb) {
    parts.push(`imdb ${match.imdb}`);
  }
  if (match.simkl) {
    parts.push(`simkl ${match.simkl}`);
  }
  return parts.join(' / ');
}

function matchPayloadIds(match) {
  // Prefer the IMDb id — the reconciler's library state and every
  // other path in this build key on it. Fall back to the Simkl id.
  return match.imdb ? { imdb: match.imdb } : { simkl: match.simkl };
}

/**
 * The Together half of a mark: post the movie to the pair's stored
 * mirror account (pair.mirrorSimkl), deduped against the mirror
 * library the same way the own mark dedupes. Driven ONLY by the
 * match's saved `watchTogether` flag — the extension's choice. The
 * Stremio-side Watch Together state (pair.watchTogether, the
 * WATCH_TOGETHER .env override, the baseline) is never consulted.
 *
 * Returns 'posted' | 'already' | 'unavailable' | 'failed'. Never
 * throws: any failure is logged and returned as 'failed', so a
 * mirror problem can never fail the own mark.
 */
async function mirrorEinthusanMark({
  pairName,
  match,
  titleLabel,
  secret,
  dataDir,
  loadPairsFn,
  fetchLibraryFn,
  postHistoryFn,
  refreshAuthFn,
  persistAuthFn,
  dbg,
}) {
  const name = typeof pairName === 'string' ? pairName.trim() : '';
  let pairs = null;
  try {
    pairs = loadPairsFn(secret, dataDir);
  } catch {
    pairs = null;
  }
  const pair = (pairs || []).find((entry) => entry.name === name);
  if (!pair?.mirrorSimkl?.access_token || !pair?.mirrorSimkl?.client_id) {
    dbg(
      `mirror unavailable ${titleLabel} (${matchIdsLabel(match)}) (no mirror sign-in on pair)`,
    );
    return 'unavailable';
  }
  try {
    return await withPairAuth({
      pairName,
      secret,
      dataDir,
      loadPairsFn,
      refreshAuthFn,
      persistAuthFn,
      dbg,
      target: 'mirrorSimkl',
      operation: async (auth) => {
        if (match.imdb) {
          const library = await fetchLibraryFn(auth);
          if (library?.movies?.has(match.imdb)) {
            dbg(
              `mirror skipped ${titleLabel} (${matchIdsLabel(match)}) (already on mirror Simkl)`,
            );
            return 'already';
          }
        }
        let status = null;
        let added = null;
        await postHistoryFn(
          auth,
          { movies: [{ ids: matchPayloadIds(match) }], shows: [] },
          (info) => {
            status = info.status;
            if (info.added) {
              added = info.added;
            }
          },
        );
        if (added && typeof added.movies === 'number' && added.movies === 0) {
          dbg(
            `mirror skipped ${titleLabel} (${matchIdsLabel(match)}) (already on mirror Simkl)`,
          );
          return 'already';
        }
        const confirmed = formatAddedCounts(added);
        dbg(
          `mirror posted ${titleLabel} (${matchIdsLabel(match)}) (HTTP ${status})${confirmed ? ` — ${confirmed}` : ''}`,
        );
        return 'posted';
      },
    });
  } catch (e) {
    dbg(`mirror failed ${titleLabel} (${matchIdsLabel(match)}) — ${e.message}`);
    return 'failed';
  }
}

/**
 * Mark the saved match for one Einthusan page watched on the pair's
 * own Simkl. Dedupes against the pair's Simkl library first: an
 * already-watched movie is reported back as alreadyWatched and never
 * posted again. A post Simkl confirms added nothing (its own library
 * state raced ours) is reported the same way. On a confirmed mark the
 * saved match record is stamped with markedAt.
 *
 * When the saved match carries the extension's Together choice, the
 * movie is then also posted to the pair's mirror account (see
 * mirrorEinthusanMark); the response's `mirror` field reports
 * 'posted' | 'already' | 'unavailable' | 'failed', or 'off' for a
 * Solo match. A mirror failure never fails the own mark.
 */
export async function einthusanMark({
  pairName,
  siteId,
  secret,
  dataDir = getDataDir(),
  loadPairsFn = loadPairs,
  fetchLibraryFn = fetchSimklLibrary,
  postHistoryFn = postHistory,
  refreshAuthFn = refreshSimklAuth,
  persistAuthFn = updatePairAuth,
  dbg = (message) => writeDebugLog('einthusan', message, dataDir),
} = {}) {
  const id = validateSiteId(siteId);
  const match = getEinthusanMatch(id, dataDir);
  if (!match) {
    throw badRequest(
      'No saved match for this Einthusan movie yet — confirm the movie in the panel first',
    );
  }
  const titleLabel = match.year ? `${match.title} (${match.year})` : match.title;

  const result = await withPairAuth({
    pairName,
    secret,
    dataDir,
    loadPairsFn,
    refreshAuthFn,
    persistAuthFn,
    dbg,
    operation: async (auth) => {
      const library = await fetchLibraryFn(auth);
      if (match.imdb && library?.movies?.has(match.imdb)) {
        dbg(`already on Simkl — ${titleLabel} (${matchIdsLabel(match)}) not posted again`);
        return { alreadyWatched: true, posted: false, status: null, added: null };
      }
      let status = null;
      let added = null;
      await postHistoryFn(
        auth,
        { movies: [{ ids: matchPayloadIds(match) }], shows: [] },
        (info) => {
          status = info.status;
          if (info.added) {
            added = info.added;
          }
        },
      );
      if (added && typeof added.movies === 'number' && added.movies === 0) {
        dbg(
          `already on Simkl — ${titleLabel} (${matchIdsLabel(match)}) (HTTP ${status}) — Simkl added 0 movie(s)`,
        );
        return { alreadyWatched: true, posted: true, status, added };
      }
      const confirmed = formatAddedCounts(added);
      dbg(
        `marked ${titleLabel} (${matchIdsLabel(match)}) (HTTP ${status})${confirmed ? ` — ${confirmed}` : ''}`,
      );
      return { alreadyWatched: false, posted: true, status, added };
    },
  }).catch((e) => {
    if (e instanceof EinthusanError) {
      throw e;
    }
    throw new EinthusanError(502, `Simkl mark failed: ${e.message}`);
  });

  if (result.posted || result.alreadyWatched) {
    try {
      const matches = loadEinthusanMatches(dataDir);
      if (matches[id] && !matches[id].markedAt) {
        matches[id].markedAt = new Date().toISOString();
        saveEinthusanMatches(matches, dataDir);
      }
    } catch {
      // The mark itself landed; a failed stamp must not fail the call.
    }
  }

  // The extension's Together choice, saved on the match. Solo stops
  // here; Together mirrors to the pair's stored mirror account. A
  // mirror failure is caught, logged, and reported — never thrown.
  let mirror = 'off';
  if (match.watchTogether === true) {
    try {
      mirror = await mirrorEinthusanMark({
        pairName,
        match,
        titleLabel,
        secret,
        dataDir,
        loadPairsFn,
        fetchLibraryFn,
        postHistoryFn,
        refreshAuthFn,
        persistAuthFn,
        dbg,
      });
    } catch (e) {
      dbg(`mirror failed ${titleLabel} (${matchIdsLabel(match)}) — ${e.message}`);
      mirror = 'failed';
    }
  }

  return { ok: true, match, ...result, mirror };
}

// Re-exported so the route and tests parse /sync/history counts the
// same way the reconciler does.
export { parseAddedCounts };
