import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { debugLogPath } from '../src/reconciler/debug-log.mjs';
import { loadPairs, savePairs } from '../src/reconciler/pairs-store.mjs';
import {
  RemoveHistoryError,
  removeHistoryItem,
  validateRemoveRequest,
} from '../src/reconciler/remove-history.mjs';
import {
  formatRemovedCounts,
  parseRemovedCounts,
} from '../src/reconciler/simkl.mjs';
import { HttpError } from '../src/reconciler/stremio.mjs';
import { addToWatchTogetherBaseline } from '../src/reconciler/watch-together-baseline.mjs';

const SECRET = 'test-secret-for-remove-history-tests';
const FAR_FUTURE = Date.now() + 7 * 24 * 60 * 60 * 1000;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'simklstremio-remove-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseline(overrides = {}) {
  return {
    version: 1,
    capturedAt: '2026-11-02T00:00:00.000Z',
    movies: ['tt1000001'],
    shows: { tt1000010: ['1:1', '1:2'] },
    ...overrides,
  };
}

function tkPair(overrides = {}) {
  return {
    name: 'TK',
    stremioAuthKey: 'test-stremio-key',
    simkl: {
      access_token: 'tk' + '-token',
      client_id: 'tk-client',
      refresh_token: 'tk' + '-refresh',
      expires_at: FAR_FUTURE,
    },
    watchTogether: true,
    watchTogetherAppliedMode: 'on',
    mirrorSimkl: {
      access_token: 'mirror' + '-token',
      client_id: 'mirror-client',
      refresh_token: 'mirror' + '-refresh',
      expires_at: FAR_FUTURE,
    },
    watchTogetherBaseline: baseline(),
    ...overrides,
  };
}

function angePair(overrides = {}) {
  return {
    name: 'Ange',
    stremioAuthKey: 'test-stremio-key-ange',
    simkl: { access_token: 'ange-token', client_id: 'ange-client' },
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

/** A removeFn seam that records calls and replies with `deleted` counts. */
function recordingRemove(calls, deleted = { movies: 0, shows: 0, episodes: 1 }) {
  return async (auth, payload) => {
    calls.push({ auth, payload });
    return { data: { deleted }, status: 201 };
  };
}

function is400(e) {
  return e instanceof RemoveHistoryError && e.status === 400;
}

test('validateRemoveRequest: shape, pairing, and ranges', () => {
  assert.deepEqual(
    validateRemoveRequest({ pairName: ' TK ', target: 'own', imdb: 'tt0121955' }),
    { pairName: 'TK', target: 'own', item: { imdb: 'tt0121955', season: undefined, episode: undefined } },
  );
  assert.deepEqual(
    validateRemoveRequest({
      pairName: 'TK',
      target: 'mirror',
      imdb: 'tt0121955',
      season: '29',
      episode: 4,
    }).item,
    { imdb: 'tt0121955', season: 29, episode: 4 },
  );

  const bad = [
    null,
    {},
    { pairName: '', target: 'own', imdb: 'tt0121955' },
    { pairName: 'TK', target: 'both', imdb: 'tt0121955' },
    { pairName: 'TK', imdb: 'tt0121955' },
    { pairName: 'TK', target: 'own', imdb: '12345' },
    { pairName: 'TK', target: 'own', imdb: 'ttABC' },
    { pairName: 'TK', target: 'own', imdb: 'tt0121955', season: 1 },
    { pairName: 'TK', target: 'own', imdb: 'tt0121955', episode: 2 },
    { pairName: 'TK', target: 'own', imdb: 'tt0121955', season: -1, episode: 2 },
    { pairName: 'TK', target: 'own', imdb: 'tt0121955', season: 1, episode: 0 },
    { pairName: 'TK', target: 'own', imdb: 'tt0121955', season: 1.5, episode: 2 },
  ];
  for (const body of bad) {
    assert.throws(() => validateRemoveRequest(body), is400, JSON.stringify(body));
  }
});

test('parseRemovedCounts / formatRemovedCounts mirror the added pair', () => {
  assert.deepEqual(
    parseRemovedCounts({ deleted: { movies: 1, shows: 0, episodes: 4 } }),
    { movies: 1, shows: 0, episodes: 4 },
  );
  // Fallback key.
  assert.deepEqual(parseRemovedCounts({ removed: { episodes: 2 } }), {
    movies: null,
    shows: null,
    episodes: 2,
  });
  assert.equal(parseRemovedCounts({}), null);
  assert.equal(parseRemovedCounts({ deleted: { movies: 'x' } }), null);
  assert.equal(parseRemovedCounts(null), null);

  assert.equal(
    formatRemovedCounts({ movies: 0, shows: 0, episodes: 1 }),
    'Simkl removed 1 episode(s)',
  );
  assert.equal(
    formatRemovedCounts({ movies: 2, shows: 1, episodes: 3 }),
    'Simkl removed 2 movie(s), 3 episode(s)',
  );
  assert.equal(
    formatRemovedCounts({ movies: 0, shows: 0, episodes: 0 }),
    'Simkl removed 0 movie(s), 0 episode(s)',
  );
  assert.equal(formatRemovedCounts(null), null);
});

test('addToWatchTogetherBaseline adds, sorts, dedupes, never mutates', () => {
  const base = baseline();
  const withMovie = addToWatchTogetherBaseline(base, { imdb: 'tt0999999' });
  assert.deepEqual(withMovie.movies, ['tt0999999', 'tt1000001'].sort());
  assert.deepEqual(base.movies, ['tt1000001']); // input untouched

  const withEpisode = addToWatchTogetherBaseline(base, {
    imdb: 'tt1000010',
    season: 1,
    episode: 3,
  });
  assert.deepEqual(withEpisode.shows.tt1000010, ['1:1', '1:2', '1:3']);

  const newShow = addToWatchTogetherBaseline(base, {
    imdb: 'tt2000000',
    season: 2,
    episode: 1,
  });
  assert.deepEqual(newShow.shows.tt2000000, ['2:1']);

  const dupe = addToWatchTogetherBaseline(base, {
    imdb: 'tt1000010',
    season: 1,
    episode: 2,
  });
  assert.deepEqual(dupe.shows.tt1000010, ['1:1', '1:2']);
});

test('own movie removal: own creds, history payload shape, baseline untouched', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair(), angePair()], SECRET, dataDir);
  const calls = [];
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'own', imdb: 'tt1000001' },
    secret: SECRET,
    dataDir,
    removeFn: recordingRemove(calls, { movies: 1, shows: 0, episodes: 0 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.baselineUpdated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth.client_id, 'tk-client');
  assert.deepEqual(calls[0].payload, {
    movies: [{ ids: { imdb: 'tt1000001' } }],
    shows: [],
  });
  assert.match(result.note, /flagged watched in Stremio/);

  const stored = loadPairs(SECRET, dataDir).find((p) => p.name === 'TK');
  assert.deepEqual(stored.watchTogetherBaseline, baseline());
  assert.match(
    readDebugLog(dataDir),
    /\[remove\] removed tt1000001 from own of pair TK \(HTTP 201\) — Simkl removed 1 movie\(s\)/,
  );
});

test('mirror episode removal: mirror creds, payload shape, item lands in the baseline', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair(), angePair()], SECRET, dataDir);
  const calls = [];
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'mirror', imdb: 'tt1000010', season: 1, episode: 3 },
    secret: SECRET,
    dataDir,
    removeFn: recordingRemove(calls, { movies: 0, shows: 0, episodes: 1 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.baselineUpdated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth.client_id, 'mirror-client');
  assert.deepEqual(calls[0].payload, {
    movies: [],
    shows: [
      {
        ids: { imdb: 'tt1000010' },
        seasons: [{ number: 1, episodes: [{ number: 3 }] }],
      },
    ],
  });
  assert.match(result.note, /starting point/);

  const stored = loadPairs(SECRET, dataDir).find((p) => p.name === 'TK');
  assert.deepEqual(stored.watchTogetherBaseline.shows.tt1000010, [
    '1:1',
    '1:2',
    '1:3',
  ]);
  assert.deepEqual(stored.watchTogetherBaseline.movies, ['tt1000001']);
  // The refreshed-token machinery must not have clobbered the tokens.
  assert.equal(stored.mirrorSimkl.access_token, 'mirror-token');
  assert.equal(stored.simkl.access_token, 'tk-token');

  const log = readDebugLog(dataDir);
  assert.match(
    log,
    /\[remove\] removed tt1000010 S1E3 from mirror of pair TK \(HTTP 201\) — Simkl removed 1 episode\(s\)/,
  );
  assert.match(log, /added tt1000010 S1E3 to the Watch Together starting point/);
});

test('mirror movie removal adds the movie to the baseline', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair()], SECRET, dataDir);
  const calls = [];
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'mirror', imdb: 'tt1000002' },
    secret: SECRET,
    dataDir,
    removeFn: recordingRemove(calls, { movies: 1, shows: 0, episodes: 0 }),
  });
  assert.equal(result.baselineUpdated, true);
  const stored = loadPairs(SECRET, dataDir).find((p) => p.name === 'TK');
  assert.deepEqual(stored.watchTogetherBaseline.movies, [
    'tt1000001',
    'tt1000002',
  ]);
});

test('mirror removal with no valid baseline: removal stands, baseline step reported skipped', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair({ watchTogetherBaseline: null })], SECRET, dataDir);
  const calls = [];
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'mirror', imdb: 'tt1000002' },
    secret: SECRET,
    dataDir,
    removeFn: recordingRemove(calls, { movies: 1, shows: 0, episodes: 0 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.baselineUpdated, false);
  assert.equal(result.baselineNote, 'no-baseline');
  assert.match(result.note, /No Watch Together starting point is saved/);
  assert.equal(calls.length, 1);
});

test('unknown pair and mirror-less pair are 400s before any Simkl call', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair(), angePair()], SECRET, dataDir);
  const calls = [];
  const removeFn = recordingRemove(calls);

  await assert.rejects(
    removeHistoryItem({
      body: { pairName: 'Nobody', target: 'own', imdb: 'tt1000001' },
      secret: SECRET,
      dataDir,
      removeFn,
    }),
    is400,
  );
  await assert.rejects(
    removeHistoryItem({
      body: { pairName: 'Ange', target: 'mirror', imdb: 'tt1000001' },
      secret: SECRET,
      dataDir,
      removeFn,
    }),
    is400,
  );
  assert.equal(calls.length, 0);
});

test('401 refreshes once and retries with the mirror credentials persisted', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair()], SECRET, dataDir);
  const calls = [];
  const persisted = [];
  let attempts = 0;
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'mirror', imdb: 'tt1000002' },
    secret: SECRET,
    dataDir,
    removeFn: async (auth, payload) => {
      calls.push({ auth, payload });
      attempts++;
      if (attempts === 1) {
        throw new HttpError(401, 'POST /sync/history/remove: Simkl returned 401 (token rejected)');
      }
      return { data: { deleted: { movies: 1, shows: 0, episodes: 0 } }, status: 201 };
    },
    refreshAuthFn: async (auth) => ({
      ...auth,
      access_token: 'fresh' + '-mirror-token',
    }),
    persistAuthFn: (name, targetKey, auth) => {
      persisted.push({ name, targetKey, auth });
      return true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth.access_token, 'fresh-mirror-token');
  assert.deepEqual(persisted, [
    {
      name: 'TK',
      targetKey: 'mirrorSimkl',
      auth: persisted[0].auth,
    },
  ]);
  assert.equal(persisted[0].auth.access_token, 'fresh-mirror-token');
});

test('401 with no refresh token is a 502 and removes nothing', async (t) => {
  const dataDir = tempDir(t);
  const pair = tkPair();
  delete pair.mirrorSimkl.refresh_token;
  savePairs([pair], SECRET, dataDir);
  await assert.rejects(
    removeHistoryItem({
      body: { pairName: 'TK', target: 'mirror', imdb: 'tt1000002' },
    secret: SECRET,
      dataDir,
      removeFn: async () => {
        throw new HttpError(401, 'POST /sync/history/remove: Simkl returned 401 (token rejected)');
      },
    }),
    (e) => e instanceof RemoveHistoryError && e.status === 502,
  );
  const stored = loadPairs(SECRET, dataDir).find((p) => p.name === 'TK');
  assert.deepEqual(stored.watchTogetherBaseline, baseline());
});

test('proactive refresh: a token inside its last day is refreshed before the removal', async (t) => {
  const dataDir = tempDir(t);
  const pair = tkPair();
  pair.simkl = { ...pair.simkl, expires_at: Date.now() + 60 * 60 * 1000 };
  savePairs([pair], SECRET, dataDir);
  const calls = [];
  const result = await removeHistoryItem({
    body: { pairName: 'TK', target: 'own', imdb: 'tt1000001' },
    secret: SECRET,
    dataDir,
    removeFn: recordingRemove(calls, { movies: 1, shows: 0, episodes: 0 }),
    refreshAuthFn: async (auth) => ({ ...auth, access_token: 'fresh-own-token' }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].auth.access_token, 'fresh-own-token');
  // And the refreshed own token was persisted to the store.
  const stored = loadPairs(SECRET, dataDir).find((p) => p.name === 'TK');
  assert.equal(stored.simkl.access_token, 'fresh-own-token');
});
