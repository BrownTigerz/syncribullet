import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pako from 'pako';

import { WatchedBitField } from '../src/reconciler/bitfield.mjs';
import {
  loadPairs,
  pairsFilePath,
  savePairs,
  updatePairAuth,
  upsertPair,
} from '../src/reconciler/pairs-store.mjs';
import {
  reconcilePair,
  runReconcilerOnce,
} from '../src/reconciler/reconcile.mjs';
import {
  parseSimklLibrary,
  simklHasEpisode,
} from '../src/reconciler/simkl.mjs';
import { extractWatched } from '../src/reconciler/stremio.mjs';
import {
  WatchTogetherBaselineError,
  captureWatchTogetherBaseline,
  createWatchTogetherBaseline,
  resolveWatchTogetherBaseline,
  subtractWatchTogetherBaseline,
} from '../src/reconciler/watch-together-baseline.mjs';

const SECRET = 'test-secret-for-reconciler-tests';
const silentLog = { log() {}, warn() {}, error() {} };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'simklstremio-reconciler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function movieItem(imdb) {
  return {
    _id: imdb,
    type: 'movie',
    name: imdb,
    removed: false,
    state: { flaggedWatched: true },
  };
}

function seriesItem(imdb, season, episode) {
  return {
    _id: imdb,
    type: 'series',
    name: imdb,
    removed: false,
    state: { flaggedWatched: true, season, episode },
  };
}

function seriesVideos(imdb, episodeNumbers) {
  return episodeNumbers.map((episode) => ({
    id: `${imdb}:1:${episode}`,
    season: 1,
    episode,
  }));
}

function simklMovie(imdb) {
  return { movie: { ids: { imdb } }, status: 'completed' };
}

function simklShow(imdb, episodeNumbers) {
  return {
    show: { ids: { imdb } },
    status: 'watching',
    seasons: [
      {
        number: 1,
        episodes: episodeNumbers.map((number) => ({
          number,
          watched: true,
        })),
      },
    ],
  };
}

function baseline(movies = [], shows = {}) {
  return {
    version: 1,
    capturedAt: '2026-11-01T12:00:00.000Z',
    movies,
    shows,
  };
}

function installReconcilerFetch(t, { items, videosByShow, libraries }) {
  const calls = { posts: [], simklGets: [] };
  installFetch(t, async (url, options = {}) => {
    const href = String(url);
    if (href === 'https://api.strem.io/api/datastoreGet') {
      return jsonResponse({ result: items });
    }
    if (href.startsWith('https://v3-cinemeta.strem.io/meta/series/')) {
      const imdb = decodeURIComponent(
        href.split('/').pop().replace(/\.json$/, ''),
      );
      return jsonResponse({ meta: { videos: videosByShow[imdb] || [] } });
    }
    if (href.startsWith('https://api.simkl.com/sync/all-items/')) {
      const auth = options.headers?.Authorization;
      calls.simklGets.push(auth);
      return jsonResponse(libraries[auth] || { movies: [], shows: [] });
    }
    if (href === 'https://api.simkl.com/sync/history/') {
      calls.posts.push({
        auth: options.headers?.Authorization,
        body: JSON.parse(options.body),
      });
      return jsonResponse({});
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  });
  return calls;
}

function postedItems(calls, auth) {
  const movies = new Set();
  const episodes = new Set();
  for (const post of calls.posts.filter((call) => call.auth === auth)) {
    for (const movie of post.body.movies || []) {
      movies.add(movie.ids.imdb);
    }
    for (const show of post.body.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          episodes.add(`${show.ids.imdb}:${season.number}:${episode.number}`);
        }
      }
    }
  }
  return { movies, episodes };
}

function makePair(overrides = {}) {
  return {
    name: 'TK',
    stremioAuthKey: 'stremio-key',
    simkl: { access_token: 'primary-token', client_id: 'primary-client' },
    watchTogether: true,
    mirrorSimkl: {
      access_token: 'mirror-token',
      client_id: 'mirror-client',
    },
    ...overrides,
  };
}

test('pair store encrypts pairs and updates auth', (t) => {
  const dataDir = tempDir(t);
  const pair = makePair({ watchTogetherBaseline: baseline(['tt0000001']) });
  savePairs([pair], SECRET, dataDir);

  const raw = readFileSync(pairsFilePath(dataDir), 'utf8');
  assert.equal(raw.includes('primary-token'), false);
  assert.equal(raw.includes('mirror-token'), false);
  assert.deepEqual(loadPairs(SECRET, dataDir), [pair]);
  assert.throws(() => loadPairs('wrong-secret', dataDir));

  const replacement = { ...pair, simkl: { access_token: 'new-token', client_id: 'primary-client' } };
  upsertPair(replacement, SECRET, dataDir);
  assert.equal(loadPairs(SECRET, dataDir).length, 1);
  assert.equal(
    updatePairAuth(
      'TK',
      'mirrorSimkl',
      { access_token: 'new-mirror-token', client_id: 'mirror-client' },
      SECRET,
      dataDir,
    ),
    true,
  );
  assert.equal(
    loadPairs(SECRET, dataDir)[0].mirrorSimkl.access_token,
    'new-mirror-token',
  );
});

test('Simkl library parsing keeps completed movies and episode rows', () => {
  const library = parseSimklLibrary({
    movies: [simklMovie('tt0000001')],
    shows: [
      simklShow('tt0000010', [1, 3]),
      {
        show: { ids: { imdb: 'tt0000020' } },
        status: 'completed',
        last_watched: 'S2E4',
        seasons: [],
      },
    ],
  });

  assert.equal(library.movies.has('tt0000001'), true);
  assert.equal(simklHasEpisode(library.shows.get('tt0000010'), 1, 1), true);
  assert.equal(simklHasEpisode(library.shows.get('tt0000010'), 1, 2), false);
  assert.equal(simklHasEpisode(library.shows.get('tt0000020'), 1, 1), true);
});

test('watched bitfield keeps skipped episodes unwatched', () => {
  const imdb = 'tt2000010';
  const videoIds = [1, 2, 3].map((episode) => `${imdb}:1:${episode}`);
  const packed = pako.deflate(new Uint8Array([0b101]));
  const serialized = `${videoIds[2]}:3:${Buffer.from(packed).toString('base64')}`;
  const bitfield = WatchedBitField.constructAndResize(serialized, videoIds);

  assert.equal(bitfield.getVideo(videoIds[0]), true);
  assert.equal(bitfield.getVideo(videoIds[1]), false);
  assert.equal(bitfield.getVideo(videoIds[2]), true);
});

test('watched extraction ignores removed and unwatched items and counts non-IMDb items', async (t) => {
  const imdb = 'tt2000020';
  installFetch(t, async (url) => {
    assert.match(String(url), /v3-cinemeta/);
    return jsonResponse({ meta: { videos: seriesVideos(imdb, [1, 2, 3]) } });
  });

  const watched = await extractWatched(
    [
      movieItem('tt2000001'),
      { ...movieItem('tt2000002'), removed: true },
      {
        _id: 'tt2000003',
        type: 'movie',
        name: 'Unwatched',
        state: { flaggedWatched: false, timesWatched: 0 },
      },
      seriesItem(imdb, 1, 2),
      {
        _id: 'kitsu:123',
        type: 'series',
        name: 'Non-IMDb',
        state: { flaggedWatched: true, season: 1, episode: 1 },
      },
    ],
    silentLog,
  );

  assert.deepEqual([...watched.movies.keys()], ['tt2000001']);
  assert.deepEqual([...watched.shows.get(imdb).episodes].sort(), ['1:1', '1:2']);
  assert.equal(watched.skipped, 1);
  assert.equal(watched.unresolved, 0);
});

test('zero-pair reconciler run writes an empty status', async (t) => {
  const dataDir = tempDir(t);
  const status = await runReconcilerOnce({
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.deepEqual(status.pairs, {});
  assert.equal(existsSync(join(dataDir, 'status.json')), true);
});

test('baseline snapshot and subtraction use movie ids and season:episode keys', () => {
  const watched = {
    movies: new Map([
      ['tt3000002', { title: 'New' }],
      ['tt3000001', { title: 'Old' }],
    ]),
    shows: new Map([
      [
        'tt3000010',
        { title: 'Show', episodes: new Set(['1:2', '1:1', '1:3']) },
      ],
    ]),
    skipped: 0,
  };

  const snapshot = createWatchTogetherBaseline(
    watched,
    '2026-11-01T12:00:00.000Z',
  );
  assert.deepEqual(snapshot, {
    version: 1,
    capturedAt: '2026-11-01T12:00:00.000Z',
    movies: ['tt3000001', 'tt3000002'],
    shows: { tt3000010: ['1:1', '1:2', '1:3'] },
  });

  const after = subtractWatchTogetherBaseline(watched, {
    ...snapshot,
    movies: ['tt3000001'],
    shows: { tt3000010: ['1:1', '1:3'] },
  });
  assert.deepEqual([...after.movies.keys()], ['tt3000002']);
  assert.deepEqual([...after.shows.get('tt3000010').episodes], ['1:2']);
});

test('baseline save rules capture on enable, keep on re-save, and drop when off', async () => {
  const existingBaseline = baseline(['tt4000001']);
  let captureCalls = 0;
  const captureBaseline = async () => {
    captureCalls++;
    return baseline(['tt4000002']);
  };

  const turnedOn = await resolveWatchTogetherBaseline({
    existingPair: { watchTogether: false, watchTogetherBaseline: null },
    watchTogether: true,
    stremioAuthKey: 'key',
    captureBaseline,
  });
  assert.deepEqual(turnedOn, baseline(['tt4000002']));
  assert.equal(captureCalls, 1);

  const kept = await resolveWatchTogetherBaseline({
    existingPair: {
      watchTogether: true,
      watchTogetherBaseline: existingBaseline,
    },
    watchTogether: true,
    stremioAuthKey: 'key',
    captureBaseline: async () => {
      throw new Error('capture must not run on a plain re-save');
    },
  });
  assert.equal(kept, existingBaseline);

  const missingBaseline = await resolveWatchTogetherBaseline({
    existingPair: { watchTogether: true, watchTogetherBaseline: null },
    watchTogether: true,
    stremioAuthKey: 'key',
    captureBaseline,
  });
  assert.deepEqual(missingBaseline, baseline(['tt4000002']));
  assert.equal(captureCalls, 2);

  const turnedOff = await resolveWatchTogetherBaseline({
    existingPair: {
      watchTogether: true,
      watchTogetherBaseline: existingBaseline,
    },
    watchTogether: false,
    stremioAuthKey: 'key',
    captureBaseline,
  });
  assert.equal(turnedOff, null);
  assert.equal(captureCalls, 2);
});

test('baseline capture fails instead of storing a partial snapshot', async () => {
  const watched = {
    movies: new Map([['tt5000001', { title: 'Movie' }]]),
    shows: new Map(),
    skipped: 0,
  };
  const captured = await captureWatchTogetherBaseline('key', {
    fetchLibrary: async () => [movieItem('tt5000001')],
    extract: async () => watched,
    capturedAt: '2026-11-01T12:00:00.000Z',
  });
  assert.deepEqual(captured.movies, ['tt5000001']);

  await assert.rejects(
    captureWatchTogetherBaseline('key', {
      fetchLibrary: async () => {
        throw new Error('Stremio unavailable');
      },
      extract: async () => watched,
    }),
    WatchTogetherBaselineError,
  );

  await assert.rejects(
    captureWatchTogetherBaseline('key', {
      fetchLibrary: async () => [],
      extract: async () => ({ ...watched, skipped: 1 }),
    }),
    /starting point would be incomplete/,
  );
});

test('mirror does not copy an item that is in the baseline', async (t) => {
  const dataDir = tempDir(t);
  const movie = 'tt6000001';
  const show = 'tt6000010';
  const calls = installReconcilerFetch(t, {
    items: [movieItem(movie), seriesItem(show, 1, 2)],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': {
        movies: [simklMovie(movie)],
        shows: [simklShow(show, [1, 2])],
      },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });
  const pair = makePair({
    watchTogetherBaseline: baseline([movie], { [show]: ['1:1', '1:2'] }),
  });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.needsBaseline, false);
  assert.equal(entry.mirrorAddedMovies, 0);
  assert.equal(entry.mirrorAddedEpisodes, 0);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
});

test('mirror copies an item watched after the baseline when the mirror is missing it', async (t) => {
  const dataDir = tempDir(t);
  const oldMovie = 'tt7000001';
  const newMovie = 'tt7000002';
  const show = 'tt7000010';
  const calls = installReconcilerFetch(t, {
    items: [
      movieItem(oldMovie),
      movieItem(newMovie),
      seriesItem(show, 1, 2),
    ],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': {
        movies: [simklMovie(oldMovie), simklMovie(newMovie)],
        shows: [simklShow(show, [1, 2])],
      },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });
  const pair = makePair({
    watchTogetherBaseline: baseline([oldMovie], { [show]: ['1:1'] }),
  });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.needsBaseline, false);
  assert.equal(entry.mirrorAddedMovies, 1);
  assert.equal(entry.mirrorAddedEpisodes, 1);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set([newMovie]),
    episodes: new Set([`${show}:1:2`]),
  });
});

test('Watch Together without a baseline mirrors nothing and flags needsBaseline', async (t) => {
  const dataDir = tempDir(t);
  const movie = 'tt8000001';
  const show = 'tt8000010';
  const calls = installReconcilerFetch(t, {
    items: [movieItem(movie), seriesItem(show, 1, 1)],
    videosByShow: { [show]: seriesVideos(show, [1, 2]) },
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });
  const pair = makePair({ watchTogetherBaseline: null });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.needsBaseline, true);
  assert.equal(entry.mirrorAddedMovies, 0);
  assert.equal(entry.mirrorAddedEpisodes, 0);
  assert.equal(calls.simklGets.includes('Bearer mirror-token'), false);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
  // The pair's own full-diff reconcile still runs in the same test below;
  // this assertion keeps the no-baseline case explicit about the mirror.
  assert.deepEqual(postedItems(calls, 'Bearer primary-token').movies, new Set([movie]));
});

test("the pair's own full-diff reconcile still posts pre-baseline items to its own Simkl", async (t) => {
  const dataDir = tempDir(t);
  const oldMovie = 'tt9000001';
  const newMovie = 'tt9000002';
  const show = 'tt9000010';
  const calls = installReconcilerFetch(t, {
    items: [
      movieItem(oldMovie),
      movieItem(newMovie),
      seriesItem(show, 1, 2),
    ],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });
  const pair = makePair({
    watchTogetherBaseline: baseline([oldMovie], { [show]: ['1:1'] }),
  });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.needsBaseline, false);
  assert.deepEqual(postedItems(calls, 'Bearer primary-token'), {
    movies: new Set([oldMovie, newMovie]),
    episodes: new Set([`${show}:1:1`, `${show}:1:2`]),
  });
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set([newMovie]),
    episodes: new Set([`${show}:1:2`]),
  });
});
