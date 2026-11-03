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
  resolveMirrorForSave,
  savePairs,
  updatePairAuth,
  updatePairWatchTogether,
  upsertPair,
} from '../src/reconciler/pairs-store.mjs';
import {
  reconcilePair,
  runReconcilerOnce,
} from '../src/reconciler/reconcile.mjs';
import { debugLogPath } from '../src/reconciler/debug-log.mjs';
import {
  formatAddedCounts,
  parseAddedCounts,
  parseSimklLibrary,
  postHistory,
  simklHasEpisode,
} from '../src/reconciler/simkl.mjs';
import { extractWatched } from '../src/reconciler/stremio.mjs';
import {
  WatchTogetherBaselineError,
  captureWatchTogetherBaseline,
  createWatchTogetherBaseline,
  effectiveWatchTogether,
  isWatchTogetherBaseline,
  parseWatchTogetherOverride,
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

function installReconcilerFetch(
  t,
  { items, videosByShow, libraries, historyAdded },
) {
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
      const body = JSON.parse(options.body);
      calls.posts.push({
        auth: options.headers?.Authorization,
        body,
      });
      const added = historyAdded
        ? historyAdded(body, options.headers?.Authorization)
        : undefined;
      return jsonResponse(added ? { added } : {});
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

test('Watch Together without a baseline captures a starting point and mirrors nothing beyond it', async (t) => {
  // Changed with the .env solo/together switch: under the transition
  // rules, a Watch Together pair with mirror credentials but no
  // valid baseline no longer sits at needsBaseline until a page
  // re-save — the reconciler captures the current watched set as the
  // starting point (the applied-mode capture path), then mirrors
  // nothing beyond it. Capture FAILURE still flags needsBaseline;
  // that case has its own test below.
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

  assert.equal(entry.needsBaseline, false);
  assert.equal(entry.mirrorAddedMovies, 0);
  assert.equal(entry.mirrorAddedEpisodes, 0);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
  // The capture stored the whole current watched set as the starting
  // point, and the run applied the on mode.
  assert.equal(isWatchTogetherBaseline(pair.watchTogetherBaseline), true);
  assert.deepEqual(pair.watchTogetherBaseline.movies, [movie]);
  assert.deepEqual(pair.watchTogetherBaseline.shows, { [show]: ['1:1'] });
  assert.equal(pair.watchTogetherAppliedMode, 'on');
  assert.match(
    readDebugLog(dataDir),
    /\[mirror:TK\] Watch Together switched on — starting point captured \(1 movie\(s\), 1 episode\(s\)\)/,
  );
  // The pair's own full-diff reconcile is unaffected by the capture.
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

function readDebugLog(dataDir) {
  const file = debugLogPath(dataDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('confirmed added counts parse defensively and render for the log', () => {
  assert.deepEqual(
    parseAddedCounts({ added: { movies: 2, shows: 1, episodes: 3 } }),
    { movies: 2, shows: 1, episodes: 3 },
  );
  // Missing `added`, non-object `added`, and unusable fields all
  // degrade to null (or null fields) instead of throwing.
  assert.equal(parseAddedCounts({}), null);
  assert.equal(parseAddedCounts(null), null);
  assert.equal(parseAddedCounts({ added: 'nope' }), null);
  assert.equal(
    parseAddedCounts({ added: { movies: 'two', episodes: -1 } }),
    null,
  );
  assert.deepEqual(
    parseAddedCounts({ added: { movies: 1, episodes: 'many' } }),
    { movies: 1, shows: null, episodes: null },
  );

  assert.equal(
    formatAddedCounts({ movies: 0, shows: 1, episodes: 1 }),
    'Simkl added 1 episode(s)',
  );
  assert.equal(
    formatAddedCounts({ movies: 2, shows: 0, episodes: 3 }),
    'Simkl added 2 movie(s), 3 episode(s)',
  );
  assert.equal(
    formatAddedCounts({ movies: 1, shows: null, episodes: null }),
    'Simkl added 1 movie(s)',
  );
  assert.equal(
    formatAddedCounts({ movies: 0, shows: 1, episodes: 0 }),
    'Simkl added 0 movie(s), 0 episode(s)',
  );
  assert.equal(formatAddedCounts({ shows: 2 }), null);
  assert.equal(formatAddedCounts(null), null);
});

test('postHistory passes per-chunk confirmed added counts to onPost', async (t) => {
  let withAdded = true;
  installFetch(t, async (url, options = {}) => {
    assert.equal(String(url), 'https://api.simkl.com/sync/history/');
    if (!withAdded) {
      return jsonResponse({}, 201);
    }
    const body = JSON.parse(options.body);
    if (body.movies.length > 0) {
      return jsonResponse({ added: { movies: 1, shows: 0, episodes: 0 } }, 201);
    }
    if (body.shows.length > 0) {
      return jsonResponse({ added: { movies: 0, shows: 1, episodes: 2 } }, 201);
    }
    return jsonResponse({}, 201);
  });

  const infos = [];
  await postHistory(
    { access_token: 'token', client_id: 'client' },
    {
      movies: [{ ids: { imdb: 'tt1100001' } }],
      shows: [{ ids: { imdb: 'tt1100010' }, seasons: [] }],
    },
    (info) => infos.push(info),
  );
  assert.deepEqual(infos, [
    {
      movies: 1,
      shows: 0,
      status: 201,
      added: { movies: 1, shows: 0, episodes: 0 },
    },
    {
      movies: 0,
      shows: 1,
      status: 201,
      added: { movies: 0, shows: 1, episodes: 2 },
    },
  ]);

  // A response with no `added` object surfaces added: null, no throw.
  withAdded = false;
  const bareInfos = [];
  await postHistory(
    { access_token: 'token', client_id: 'client' },
    { movies: [], shows: [{ ids: { imdb: 'tt1100010' }, seasons: [] }] },
    (info) => bareInfos.push(info),
  );
  assert.deepEqual(bareInfos, [
    { movies: 0, shows: 1, status: 201, added: null },
  ]);
});

test("reconciler log lines carry Simkl's confirmed added counts", async (t) => {
  const dataDir = tempDir(t);
  const movie = 'tt1100001';
  const show = 'tt1100010';
  installReconcilerFetch(t, {
    items: [movieItem(movie), seriesItem(show, 1, 2)],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
    historyAdded: (body, auth) => {
      if (body.movies.length > 0) {
        return { movies: 1, shows: 0, episodes: 0 };
      }
      // The pair posts both missing episodes; the mirror only the one
      // past its baseline (S1E1 is in the baseline).
      return auth === 'Bearer mirror-token'
        ? { movies: 0, shows: 1, episodes: 1 }
        : { movies: 0, shows: 1, episodes: 2 };
    },
  });
  const pair = makePair({
    watchTogetherBaseline: baseline([], { [show]: ['1:1'] }),
  });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.addedMovies, 1);
  assert.equal(entry.addedEpisodes, 2);
  assert.equal(entry.mirrorAddedMovies, 1);
  assert.equal(entry.mirrorAddedEpisodes, 1);
  const logText = readDebugLog(dataDir);
  assert.match(
    logText,
    /\[pair:TK\] POST \/sync\/history — 1 movie\(s\), 0 show\(s\) → HTTP 200 — Simkl added 1 movie\(s\)/,
  );
  assert.match(
    logText,
    /\[pair:TK\] POST \/sync\/history — 0 movie\(s\), 1 show\(s\) → HTTP 200 — Simkl added 2 episode\(s\)/,
  );
  assert.match(
    logText,
    /\[mirror:TK\] POST \/sync\/history — 1 movie\(s\), 0 show\(s\) → HTTP 200 — Simkl added 1 movie\(s\)/,
  );
  assert.match(
    logText,
    /\[mirror:TK\] POST \/sync\/history — 0 movie\(s\), 1 show\(s\) → HTTP 200 — Simkl added 1 episode\(s\)/,
  );
});

test('reconciler log lines stay unchanged when Simkl reports no added counts', async (t) => {
  const dataDir = tempDir(t);
  const movie = 'tt1200001';
  installReconcilerFetch(t, {
    items: [movieItem(movie)],
    videosByShow: {},
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [simklMovie(movie)], shows: [] },
    },
    // No historyAdded: history responses are bare {} like Simkl
    // responses without an `added` object.
  });
  const pair = makePair({
    watchTogetherBaseline: baseline([movie]),
  });

  const entry = await reconcilePair(pair, {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.addedMovies, 1);
  assert.equal(entry.mirrorAddedMovies, 0);
  const logText = readDebugLog(dataDir);
  assert.match(
    logText,
    /\[pair:TK\] POST \/sync\/history — 1 movie\(s\), 0 show\(s\) → HTTP 200\n/,
  );
  assert.equal(logText.includes('Simkl added'), false);
});

// --- .env solo/together switch (WATCH_TOGETHER) ----------------------

test('WATCH_TOGETHER override parses on/off/true/false only', () => {
  assert.equal(parseWatchTogetherOverride('on'), true);
  assert.equal(parseWatchTogetherOverride('ON'), true);
  assert.equal(parseWatchTogetherOverride(' true '), true);
  assert.equal(parseWatchTogetherOverride('off'), false);
  assert.equal(parseWatchTogetherOverride('False'), false);
  // Unset, empty, misspelled, or non-string values are NO override —
  // the pair's stored flag decides, never a guess.
  assert.equal(parseWatchTogetherOverride(''), null);
  assert.equal(parseWatchTogetherOverride(undefined), null);
  assert.equal(parseWatchTogetherOverride(null), null);
  assert.equal(parseWatchTogetherOverride('banana'), null);
  assert.equal(parseWatchTogetherOverride('1'), null);
  assert.equal(parseWatchTogetherOverride(true), null);

  const onPair = { watchTogether: true };
  const offPair = { watchTogether: false };
  assert.equal(effectiveWatchTogether(onPair, {}), true);
  assert.equal(effectiveWatchTogether(offPair, {}), false);
  assert.equal(
    effectiveWatchTogether(onPair, { WATCH_TOGETHER: 'off' }),
    false,
  );
  assert.equal(
    effectiveWatchTogether(offPair, { WATCH_TOGETHER: 'on' }),
    true,
  );
  assert.equal(
    effectiveWatchTogether(onPair, { WATCH_TOGETHER: 'banana' }),
    true,
  );
  assert.equal(effectiveWatchTogether(null, {}), false);
});

test('updatePairWatchTogether touches only the Watch Together fields', (t) => {
  const dataDir = tempDir(t);
  const pair = makePair();
  savePairs([pair], SECRET, dataDir);

  assert.equal(
    updatePairWatchTogether(
      'TK',
      { appliedMode: 'off' },
      SECRET,
      dataDir,
    ),
    true,
  );
  let stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(stored.watchTogetherAppliedMode, 'off');
  assert.equal(stored.watchTogetherBaseline, undefined);

  const fresh = baseline(['tt1300001']);
  assert.equal(
    updatePairWatchTogether(
      'TK',
      { baseline: fresh, appliedMode: 'on' },
      SECRET,
      dataDir,
    ),
    true,
  );
  stored = loadPairs(SECRET, dataDir)[0];
  assert.deepEqual(stored.watchTogetherBaseline, fresh);
  assert.equal(stored.watchTogetherAppliedMode, 'on');
  // Auth material is untouched by the Watch Together update.
  assert.equal(stored.simkl.access_token, 'primary-token');
  assert.equal(stored.mirrorSimkl.access_token, 'mirror-token');

  assert.equal(
    updatePairWatchTogether('Nobody', { appliedMode: 'on' }, SECRET, dataDir),
    false,
  );
});

test('resolveMirrorForSave prefers fresh credentials and parks stored ones', () => {
  const stored = {
    access_token: 'stored-token',
    client_id: 'stored-client',
    refresh_token: 'stored-refresh',
    expires_at: 123,
  };
  const existing = { name: 'TK', mirrorSimkl: stored };
  const fresh = {
    access_token: 'fresh-token',
    client_id: 'fresh-client',
  };

  assert.deepEqual(resolveMirrorForSave(fresh, existing), {
    access_token: 'fresh-token',
    client_id: 'fresh-client',
    refresh_token: undefined,
    expires_at: undefined,
  });
  // No fresh approval in this save -> the stored sign-in is parked,
  // not discarded.
  assert.equal(resolveMirrorForSave(null, existing), stored);
  assert.equal(resolveMirrorForSave(undefined, existing), stored);
  // A partial supplied value (no client_id) is not a usable sign-in.
  assert.equal(
    resolveMirrorForSave({ access_token: 'half' }, existing),
    stored,
  );
  assert.equal(resolveMirrorForSave(null, { name: 'TK' }), null);
  assert.equal(resolveMirrorForSave(null, undefined), null);
});

// Reconciler fetch stub whose datastore contents can change between
// runs inside one test (the fixed-shape installer above cannot).
function installDynamicReconcilerFetch(t, state) {
  const calls = { posts: [], simklGets: [] };
  installFetch(t, async (url, options = {}) => {
    const href = String(url);
    if (href === 'https://api.strem.io/api/datastoreGet') {
      return jsonResponse({ result: state.items });
    }
    if (href.startsWith('https://v3-cinemeta.strem.io/meta/series/')) {
      const imdb = decodeURIComponent(
        href.split('/').pop().replace(/\.json$/, ''),
      );
      return jsonResponse({ meta: { videos: state.videosByShow[imdb] || [] } });
    }
    if (href.startsWith('https://api.simkl.com/sync/all-items/')) {
      const auth = options.headers?.Authorization;
      calls.simklGets.push(auth);
      return jsonResponse(state.libraries[auth] || { movies: [], shows: [] });
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

test('switch-on captures a fresh starting point exactly once across consecutive runs', async (t) => {
  const dataDir = tempDir(t);
  const oldMovie = 'tt1400001';
  const soloMovie = 'tt1400002';
  const laterMovie = 'tt1400003';
  const show = 'tt1400010';
  // The pair comes back from a solo period: applied mode off, and a
  // starting point from BEFORE the solo watches.
  savePairs(
    [
      makePair({
        watchTogetherAppliedMode: 'off',
        watchTogetherBaseline: baseline([oldMovie], { [show]: ['1:1'] }),
      }),
    ],
    SECRET,
    dataDir,
  );
  const state = {
    items: [
      movieItem(oldMovie),
      movieItem(soloMovie),
      seriesItem(show, 1, 2),
    ],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': {
        movies: [simklMovie(oldMovie), simklMovie(soloMovie)],
        shows: [simklShow(show, [1, 2])],
      },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  };
  const calls = installDynamicReconcilerFetch(t, state);

  // Run 1: the switch is applied — a fresh starting point is
  // captured and NOTHING is mirrored, including soloMovie and S1E2,
  // which the stale pre-solo baseline would have let through.
  const run1 = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });
  assert.equal(run1.needsBaseline, false);
  assert.equal(run1.mirrorAddedMovies, 0);
  assert.equal(run1.mirrorAddedEpisodes, 0);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
  let stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(stored.watchTogetherAppliedMode, 'on');
  assert.deepEqual(stored.watchTogetherBaseline.movies, [
    oldMovie,
    soloMovie,
  ]);
  assert.deepEqual(stored.watchTogetherBaseline.shows, {
    [show]: ['1:1', '1:2'],
  });
  const capturedAt = stored.watchTogetherBaseline.capturedAt;
  assert.notEqual(capturedAt, '2026-11-01T12:00:00.000Z');

  // Run 2 (next scheduled run / restart): no recapture — the new
  // starting point stands, and a watch after it mirrors normally.
  state.items = [...state.items, movieItem(laterMovie)];
  state.libraries['Bearer primary-token'].movies.push(
    simklMovie(laterMovie),
  );
  const run2 = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });
  assert.equal(run2.mirrorAddedMovies, 1);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token').movies, new Set([laterMovie]));
  stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(stored.watchTogetherBaseline.capturedAt, capturedAt);
  const captureLines = readDebugLog(dataDir)
    .split('\n')
    .filter((line) => line.includes('starting point captured'));
  assert.equal(captureLines.length, 1);
  assert.match(
    captureLines[0],
    /\[mirror:TK\] Watch Together switched on — starting point captured \(2 movie\(s\), 2 episode\(s\)\)/,
  );
});

test('plain restart with the mode already applied mirrors against the stored baseline, no recapture', async (t) => {
  const dataDir = tempDir(t);
  const oldMovie = 'tt1500001';
  const newMovie = 'tt1500002';
  const show = 'tt1500010';
  const storedBaseline = baseline([oldMovie], { [show]: ['1:1'] });
  savePairs(
    [
      makePair({
        watchTogetherAppliedMode: 'on',
        watchTogetherBaseline: storedBaseline,
      }),
    ],
    SECRET,
    dataDir,
  );
  const calls = installReconcilerFetch(t, {
    items: [movieItem(oldMovie), movieItem(newMovie), seriesItem(show, 1, 2)],
    videosByShow: { [show]: seriesVideos(show, [1, 2, 3]) },
    libraries: {
      'Bearer primary-token': {
        movies: [simklMovie(oldMovie), simklMovie(newMovie)],
        shows: [simklShow(show, [1, 2])],
      },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });

  const entry = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.mirrorAddedMovies, 1);
  assert.equal(entry.mirrorAddedEpisodes, 1);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set([newMovie]),
    episodes: new Set([`${show}:1:2`]),
  });
  const stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(
    stored.watchTogetherBaseline.capturedAt,
    storedBaseline.capturedAt,
  );
  assert.equal(
    readDebugLog(dataDir).includes('starting point captured'),
    false,
  );
});

test('an existing valid baseline is adopted when the applied mode was never recorded', async (t) => {
  // TK's live pair on deploy day: saved by the configure page before
  // applied-mode tracking existed — flag on, baseline valid, no
  // watchTogetherAppliedMode field. The first run of the new build
  // must adopt the stored baseline, not recapture it.
  const dataDir = tempDir(t);
  const oldMovie = 'tt1600001';
  const newMovie = 'tt1600002';
  const storedBaseline = baseline([oldMovie]);
  const pair = makePair({ watchTogetherBaseline: storedBaseline });
  delete pair.watchTogetherAppliedMode;
  savePairs([pair], SECRET, dataDir);
  installReconcilerFetch(t, {
    items: [movieItem(oldMovie), movieItem(newMovie)],
    videosByShow: {},
    libraries: {
      'Bearer primary-token': {
        movies: [simklMovie(oldMovie), simklMovie(newMovie)],
        shows: [],
      },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });

  const entry = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.mirrorAddedMovies, 1);
  const stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(stored.watchTogetherAppliedMode, 'on');
  assert.equal(
    stored.watchTogetherBaseline.capturedAt,
    storedBaseline.capturedAt,
  );
  assert.equal(
    readDebugLog(dataDir).includes('starting point captured'),
    false,
  );
});

test('WATCH_TOGETHER=off suppresses the mirror while the pair flag is on, and leaves other pairs untouched', async (t) => {
  const dataDir = tempDir(t);
  const movie = 'tt1700001';
  const tk = makePair({ watchTogetherBaseline: baseline([]) });
  const ange = {
    name: 'Ange',
    stremioAuthKey: 'ange-key',
    simkl: { access_token: 'ange-token', client_id: 'ange-client' },
    watchTogether: false,
    mirrorSimkl: null,
    watchTogetherBaseline: null,
  };
  savePairs([tk, ange], SECRET, dataDir);
  const angeBefore = JSON.parse(
    JSON.stringify(loadPairs(SECRET, dataDir)[1]),
  );
  const calls = installReconcilerFetch(t, {
    items: [movieItem(movie)],
    videosByShow: {},
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
      'Bearer ange-token': { movies: [simklMovie(movie)], shows: [] },
    },
  });

  const status = await runReconcilerOnce({
    secret: SECRET,
    dataDir,
    log: silentLog,
    env: { WATCH_TOGETHER: 'off' },
  });

  // TK's own sync still runs; only the mirror is suppressed.
  assert.equal(status.pairs.TK.addedMovies, 1);
  assert.equal(status.pairs.TK.mirrorAddedMovies, 0);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
  assert.equal(calls.simklGets.includes('Bearer mirror-token'), false);
  const logText = readDebugLog(dataDir);
  const soloLines = logText
    .split('\n')
    .filter((line) =>
      line.includes('[mirror:TK] Watch Together off — mirror skipped (solo)'),
    );
  assert.equal(soloLines.length, 1);
  // Ange's pair gets no mirror lines and her stored record is
  // byte-for-byte what it was — the switch machinery never touches it.
  assert.equal(logText.includes('[mirror:Ange]'), false);
  assert.deepEqual(loadPairs(SECRET, dataDir)[1], angeBefore);
  // TK's pair remembers the applied off mode for the next switch-on.
  assert.equal(loadPairs(SECRET, dataDir)[0].watchTogetherAppliedMode, 'off');
});

test('WATCH_TOGETHER=on mirrors through a parked sign-in while the pair flag is off', async (t) => {
  const dataDir = tempDir(t);
  const newMovie = 'tt1800001';
  savePairs(
    [
      makePair({
        watchTogether: false,
        watchTogetherAppliedMode: 'on',
        watchTogetherBaseline: baseline([]),
      }),
    ],
    SECRET,
    dataDir,
  );
  const calls = installReconcilerFetch(t, {
    items: [movieItem(newMovie)],
    videosByShow: {},
    libraries: {
      'Bearer primary-token': { movies: [simklMovie(newMovie)], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });

  const entry = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
    env: { WATCH_TOGETHER: 'on' },
  });

  assert.equal(entry.mirrorAddedMovies, 1);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token').movies, new Set([newMovie]));
  assert.equal(
    readDebugLog(dataDir).includes('starting point captured'),
    false,
  );
});

test('starting-point capture failure mirrors nothing, flags needsBaseline, and does not mark the mode applied', async (t) => {
  const dataDir = tempDir(t);
  const oldMovie = 'tt1900001';
  const brokenShow = 'tt1900010';
  const storedBaseline = baseline([oldMovie]);
  savePairs(
    [
      makePair({
        watchTogetherAppliedMode: 'off',
        watchTogetherBaseline: storedBaseline,
      }),
    ],
    SECRET,
    dataDir,
  );
  // brokenShow has no Cinemeta episode list, so extraction leaves it
  // unresolved and the baseline capture must refuse a partial
  // snapshot.
  const calls = installReconcilerFetch(t, {
    items: [movieItem(oldMovie), seriesItem(brokenShow, 1, 1)],
    videosByShow: {},
    libraries: {
      'Bearer primary-token': { movies: [], shows: [] },
      'Bearer mirror-token': { movies: [], shows: [] },
    },
  });

  const entry = await reconcilePair(loadPairs(SECRET, dataDir)[0], {
    secret: SECRET,
    dataDir,
    log: silentLog,
  });

  assert.equal(entry.needsBaseline, true);
  assert.equal(entry.mirrorAddedMovies, 0);
  assert.equal(entry.mirrorAddedEpisodes, 0);
  assert.deepEqual(postedItems(calls, 'Bearer mirror-token'), {
    movies: new Set(),
    episodes: new Set(),
  });
  assert.equal(calls.simklGets.includes('Bearer mirror-token'), false);
  // The failure changes nothing on disk: the old baseline stands and
  // the applied mode stays off, so the next run retries the capture.
  const stored = loadPairs(SECRET, dataDir)[0];
  assert.equal(stored.watchTogetherAppliedMode, 'off');
  assert.deepEqual(stored.watchTogetherBaseline, storedBaseline);
  assert.match(
    readDebugLog(dataDir),
    /\[mirror:TK\] Watch Together starting-point capture failed — .* — mirroring nothing \(needsBaseline\)/,
  );
});
