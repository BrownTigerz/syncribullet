import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { debugLogPath } from '../src/reconciler/debug-log.mjs';
import {
  EinthusanError,
  clearEinthusanMatch,
  einthusanMark,
  einthusanMatchesFilePath,
  einthusanSearch,
  getEinthusanMatch,
  parseSimklSearchResults,
  saveEinthusanMatch,
  simklPosterUrl,
} from '../src/reconciler/einthusan.mjs';
import { savePairs } from '../src/reconciler/pairs-store.mjs';

const SECRET = 'test-secret-for-einthusan-tests';
const FAR_FUTURE = Date.now() + 7 * 24 * 60 * 60 * 1000;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'simklstremio-einthusan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tkPair(overrides = {}) {
  return {
    name: 'TK',
    stremioAuthKey: 'test-stremio-key',
    simkl: {
      access_token: 'tk-token',
      client_id: 'tk-client',
      refresh_token: 'tk-refresh',
      expires_at: FAR_FUTURE,
    },
    watchTogether: false,
    mirrorSimkl: null,
    watchTogetherBaseline: null,
    ...overrides,
  };
}

function readDebugLog(dataDir) {
  const file = debugLogPath(dataDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const CANDIDATE = {
  title: 'Jailer',
  year: 2023,
  simkl: 1234567,
  imdb: 'tt11663228',
  tmdb: 948549,
  poster: 'ab/123_w.jpg',
};

test('match store: save / get / clear round trip, stored next to pairs', (t) => {
  const dir = tempDir(t);
  assert.equal(getEinthusanMatch('6vB1', dir), null);

  const saved = saveEinthusanMatch(
    { ...CANDIDATE, pageTitle: 'Jailer', pageYear: 2023, pageLanguage: 'Tamil' },
    '6vB1',
    dir,
  );
  assert.equal(saved.siteId, '6vB1');
  assert.equal(saved.simkl, 1234567);
  assert.equal(saved.imdb, 'tt11663228');
  assert.equal(saved.markedAt, null);
  assert.ok(existsSync(einthusanMatchesFilePath(dir)));

  const readBack = getEinthusanMatch('6vB1', dir);
  assert.equal(readBack.title, 'Jailer');
  assert.equal(readBack.pageLanguage, 'Tamil');

  assert.equal(clearEinthusanMatch('6vB1', dir), true);
  assert.equal(getEinthusanMatch('6vB1', dir), null);
  assert.equal(clearEinthusanMatch('6vB1', dir), false);
});

test('match store: validation rejects bad site ids and id-less matches', (t) => {
  const dir = tempDir(t);
  const is400 = (e) => e instanceof EinthusanError && e.status === 400;
  assert.throws(() => saveEinthusanMatch(CANDIDATE, '', dir), is400);
  assert.throws(() => saveEinthusanMatch(CANDIDATE, 'bad id!', dir), is400);
  assert.throws(() => saveEinthusanMatch({ title: 'No Ids' }, '6vB1', dir), is400);
  assert.throws(() => saveEinthusanMatch({ simkl: 5 }, '6vB1', dir), is400);
  assert.throws(() => getEinthusanMatch('../pairs', dir), is400);
});

test('match store: re-picking a different movie clears the marked stamp', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: async () => ({ movies: new Set(), shows: new Map() }),
    postHistoryFn: async (auth, payload, onPost) =>
      onPost({ movies: 1, shows: 0, status: 201, added: { movies: 1 } }),
    dbg: () => {},
  });
  assert.ok(getEinthusanMatch('6vB1', dir).markedAt);

  // Same movie again — the stamp survives.
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  assert.ok(getEinthusanMatch('6vB1', dir).markedAt);

  // A different movie — the stamp is gone.
  saveEinthusanMatch({ ...CANDIDATE, title: 'Other', simkl: 999, imdb: 'tt9999999' }, '6vB1', dir);
  assert.equal(getEinthusanMatch('6vB1', dir).markedAt, null);
});

test('parseSimklSearchResults: both id spellings, poster prefixing, junk dropped', () => {
  const candidates = parseSimklSearchResults([
    { title: 'Jailer', year: 2023, poster: 'ab/1_w.jpg', ids: { simkl_id: 11, imdb: 'tt11663228', tmdb: 948549 } },
    { title: 'Jailer 2', year: 2025, poster: 'https://x/y.jpg', ids: { simkl: '22' } },
    { movie: { title: 'Nested', year: 2020, ids: { simkl_id: 33 } } },
    { title: 'No Ids', year: 2020, ids: {} },
    { year: 2020, ids: { simkl_id: 44 } },
    null,
    'junk',
  ]);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates[0], {
    title: 'Jailer',
    year: 2023,
    ids: { simkl: 11, imdb: 'tt11663228', tmdb: 948549 },
    poster: 'https://simkl.in/posters/ab/1_w.jpg',
  });
  assert.equal(candidates[1].ids.simkl, 22);
  assert.equal(candidates[1].poster, 'https://x/y.jpg');
  assert.equal(candidates[2].title, 'Nested');
  assert.equal(simklPosterUrl(''), null);
  assert.equal(simklPosterUrl('/lead.jpg'), 'https://simkl.in/posters/lead.jpg');
});

test('search: resolves the pair and returns parsed candidates', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  const seen = [];
  const result = await einthusanSearch({
    pairName: ' TK ',
    query: 'Jailer',
    secret: SECRET,
    dataDir: dir,
    searchFn: async (auth, q) => {
      seen.push({ client: auth.client_id, q });
      return [{ title: 'Jailer', year: 2023, ids: { simkl: 11, imdb: 'tt11663228', tmdb: null }, poster: null }];
    },
    dbg: () => {},
  });
  assert.equal(seen[0].client, 'tk-client');
  assert.equal(seen[0].q, 'Jailer');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].ids.simkl, 11);

  await assert.rejects(
    () => einthusanSearch({ pairName: 'Nobody', query: 'X', secret: SECRET, dataDir: dir, searchFn: async () => [], dbg: () => {} }),
    (e) => e instanceof EinthusanError && e.status === 400,
  );
  await assert.rejects(
    () => einthusanSearch({ pairName: 'TK', query: '  ', secret: SECRET, dataDir: dir, searchFn: async () => [], dbg: () => {} }),
    (e) => e instanceof EinthusanError && e.status === 400,
  );
});

test('mark: already in the Simkl library — no post, reported as watched', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  let posts = 0;
  const lines = [];
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: async () => ({ movies: new Set(['tt11663228']), shows: new Map() }),
    postHistoryFn: async () => {
      posts += 1;
    },
    dbg: (m) => lines.push(m),
  });
  assert.equal(posts, 0);
  assert.equal(result.alreadyWatched, true);
  assert.equal(result.posted, false);
  assert.match(lines.join('\n'), /already on Simkl/);
});

test('mark: not in the library — posts once, confirmed counts logged', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  const calls = [];
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: async () => ({ movies: new Set(), shows: new Map() }),
    postHistoryFn: async (auth, payload, onPost) => {
      calls.push(payload);
      onPost({ movies: 1, shows: 0, status: 201, added: { movies: 1, shows: 0, episodes: 0 } });
      return { movies: 1, shows: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { movies: [{ ids: { imdb: 'tt11663228' } }], shows: [] });
  assert.equal(result.alreadyWatched, false);
  assert.equal(result.posted, true);
  const log = readDebugLog(dir);
  assert.match(log, /\[einthusan\] marked Jailer \(2023\) \(imdb tt11663228 \/ simkl 1234567\) \(HTTP 201\) — Simkl added 1 movie\(s\)/);
  assert.ok(getEinthusanMatch('6vB1', dir).markedAt);
});

test('mark: a post Simkl confirms added 0 — reported as already watched', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: async () => ({ movies: new Set(), shows: new Map() }),
    postHistoryFn: async (auth, payload, onPost) => {
      onPost({ movies: 1, shows: 0, status: 201, added: { movies: 0 } });
      return { movies: 1, shows: 0 };
    },
    dbg: () => {},
  });
  assert.equal(result.alreadyWatched, true);
  assert.equal(result.posted, true);
});

test('mark: simkl-only match posts by Simkl id, library check skipped', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch({ title: 'Obscure', year: 1999, simkl: 4242 }, 'Ab12', dir);
  const calls = [];
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: 'Ab12',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: async () => ({ movies: new Set(['tt0000001']), shows: new Map() }),
    postHistoryFn: async (auth, payload, onPost) => {
      calls.push(payload);
      onPost({ movies: 1, shows: 0, status: 201, added: { movies: 1 } });
      return { movies: 1, shows: 0 };
    },
    dbg: () => {},
  });
  assert.deepEqual(calls[0].movies, [{ ids: { simkl: 4242 } }]);
  assert.equal(result.posted, true);
});

const MIRROR_AUTH = {
  access_token: 'ange-token',
  client_id: 'ange-client',
  refresh_token: 'ange-refresh',
  expires_at: FAR_FUTURE,
};

function tkPairWithMirror(overrides = {}) {
  return tkPair({ mirrorSimkl: { ...MIRROR_AUTH }, ...overrides });
}

// Simkl fakes that route by the token they are called with, so a
// test sees exactly which account each library read / post touched.
function routedSimkl({ ownMovies = [], mirrorMovies = [], failMirrorPost = false } = {}) {
  const calls = { library: [], posts: [] };
  return {
    calls,
    fetchLibraryFn: async (auth) => {
      calls.library.push(auth.access_token);
      const movies = auth.access_token === 'ange-token' ? mirrorMovies : ownMovies;
      return { movies: new Set(movies), shows: new Map() };
    },
    postHistoryFn: async (auth, payload, onPost) => {
      calls.posts.push({ token: auth.access_token, payload });
      if (failMirrorPost && auth.access_token === 'ange-token') {
        throw new Error('Simkl exploded');
      }
      onPost({ movies: 1, shows: 0, status: 201, added: { movies: 1, shows: 0, episodes: 0 } });
      return { movies: 1, shows: 0 };
    },
  };
}

test('match store: watchTogether persists with the match, default Solo', (t) => {
  const dir = tempDir(t);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  assert.equal(getEinthusanMatch('6vB1', dir).watchTogether, true);

  saveEinthusanMatch(CANDIDATE, 'Ab12', dir);
  assert.equal(getEinthusanMatch('Ab12', dir).watchTogether, false);

  // Re-saving the same movie with the other choice flips the flag.
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: false }, '6vB1', dir);
  assert.equal(getEinthusanMatch('6vB1', dir).watchTogether, false);
});

test('mark Together: not on the mirror library — mirrored after the own mark', async (t) => {
  const dir = tempDir(t);
  // Pair flag watchTogether stays false on purpose: the extension's
  // per-match choice alone drives Einthusan mirroring.
  savePairs([tkPairWithMirror()], SECRET, dir);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  const simkl = routedSimkl({});
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
  });
  assert.equal(result.posted, true);
  assert.equal(result.mirror, 'posted');
  assert.deepEqual(simkl.calls.library, ['tk-token', 'ange-token']);
  assert.deepEqual(
    simkl.calls.posts.map((c) => c.token),
    ['tk-token', 'ange-token'],
  );
  assert.deepEqual(simkl.calls.posts[1].payload, {
    movies: [{ ids: { imdb: 'tt11663228' } }],
    shows: [],
  });
  const log = readDebugLog(dir);
  assert.match(
    log,
    /\[einthusan\] mirror posted Jailer \(2023\) \(imdb tt11663228 \/ simkl 1234567\) \(HTTP 201\) — Simkl added 1 movie\(s\)/,
  );
});

test('mark Together: already on the mirror library — skipped, no mirror post', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPairWithMirror()], SECRET, dir);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  const simkl = routedSimkl({ mirrorMovies: ['tt11663228'] });
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
  });
  assert.equal(result.posted, true);
  assert.equal(result.mirror, 'already');
  assert.deepEqual(
    simkl.calls.posts.map((c) => c.token),
    ['tk-token'],
  );
  const log = readDebugLog(dir);
  assert.match(log, /\[einthusan\] mirror skipped Jailer \(2023\) .*\(already on mirror Simkl\)/);
});

test('mark Together: own already watched — the mirror still runs', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPairWithMirror()], SECRET, dir);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  const simkl = routedSimkl({ ownMovies: ['tt11663228'] });
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
    dbg: () => {},
  });
  assert.equal(result.alreadyWatched, true);
  assert.equal(result.mirror, 'posted');
  assert.deepEqual(
    simkl.calls.posts.map((c) => c.token),
    ['ange-token'],
  );
});

test('mark Together: no mirror sign-in on the pair — own mark only, mirror unavailable', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  const simkl = routedSimkl({});
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
  });
  assert.equal(result.posted, true);
  assert.equal(result.mirror, 'unavailable');
  assert.deepEqual(simkl.calls.library, ['tk-token']);
  assert.deepEqual(
    simkl.calls.posts.map((c) => c.token),
    ['tk-token'],
  );
  const log = readDebugLog(dir);
  assert.match(log, /\[einthusan\] mirror unavailable Jailer \(2023\) .*\(no mirror sign-in on pair\)/);
});

test('mark Solo: the mirror account is never touched', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPairWithMirror()], SECRET, dir);
  saveEinthusanMatch(CANDIDATE, '6vB1', dir);
  const simkl = routedSimkl({});
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
    dbg: () => {},
  });
  assert.equal(result.posted, true);
  assert.equal(result.mirror, 'off');
  assert.deepEqual(simkl.calls.library, ['tk-token']);
  assert.deepEqual(
    simkl.calls.posts.map((c) => c.token),
    ['tk-token'],
  );
});

test('mark Together: mirror post throws — own mark still succeeds, mirror failed', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPairWithMirror()], SECRET, dir);
  saveEinthusanMatch({ ...CANDIDATE, watchTogether: true }, '6vB1', dir);
  const simkl = routedSimkl({ failMirrorPost: true });
  const result = await einthusanMark({
    pairName: 'TK',
    siteId: '6vB1',
    secret: SECRET,
    dataDir: dir,
    fetchLibraryFn: simkl.fetchLibraryFn,
    postHistoryFn: simkl.postHistoryFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(result.mirror, 'failed');
  assert.ok(getEinthusanMatch('6vB1', dir).markedAt);
  const log = readDebugLog(dir);
  assert.match(log, /\[einthusan\] mirror failed Jailer \(2023\)/);
});

test('mark: no saved match — 400, nothing posted', async (t) => {
  const dir = tempDir(t);
  savePairs([tkPair()], SECRET, dir);
  await assert.rejects(
    () =>
      einthusanMark({
        pairName: 'TK',
        siteId: '6vB1',
        secret: SECRET,
        dataDir: dir,
        fetchLibraryFn: async () => ({ movies: new Set(), shows: new Map() }),
        postHistoryFn: async () => {},
        dbg: () => {},
      }),
    (e) => e instanceof EinthusanError && e.status === 400,
  );
});
