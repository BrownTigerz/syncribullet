import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { debugLogPath } from '../src/reconciler/debug-log.mjs';
import {
  buildMirrorPayload,
  decideLiveMirror,
  itemInBaseline,
  mirrorLivePick,
} from '../src/reconciler/live-mirror.mjs';
import { savePairs } from '../src/reconciler/pairs-store.mjs';
import { HttpError } from '../src/reconciler/stremio.mjs';

const SECRET = 'test-secret-for-live-mirror-tests';
const FAR_FUTURE = Date.now() + 7 * 24 * 60 * 60 * 1000;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'simklstremio-live-mirror-'));
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
    simkl: { access_token: 'tk-token', client_id: 'tk-client' },
    watchTogether: true,
    mirrorSimkl: {
      access_token: 'mirror-token',
      client_id: 'mirror-client',
      refresh_token: 'mirror-refresh',
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

function recordingPostHistory(calls, behaviour) {
  return async (auth, payload, onPost) => {
    calls.push({ auth, payload });
    if (behaviour) {
      await behaviour(auth, payload, calls.length);
    }
    if (onPost) {
      onPost({
        movies: payload.movies.length,
        shows: payload.shows.length,
        status: 201,
      });
    }
    return { movies: payload.movies.length, shows: payload.shows.length };
  };
}

function baseOptions(t, overrides = {}) {
  return {
    secret: SECRET,
    dataDir: tempDir(t),
    loadPairsFn: () => [tkPair(), angePair()],
    postHistoryFn: recordingPostHistory([]),
    ...overrides,
  };
}

test('baseline check uses movie ids and season:episode keys', () => {
  const base = baseline();
  assert.equal(itemInBaseline(base, { imdb: 'tt1000001' }), true);
  assert.equal(itemInBaseline(base, { imdb: 'tt1000002' }), false);
  assert.equal(
    itemInBaseline(base, { imdb: 'tt1000010', season: 1, episode: 2 }),
    true,
  );
  assert.equal(
    itemInBaseline(base, { imdb: 'tt1000010', season: 1, episode: 3 }),
    false,
  );
  assert.equal(
    itemInBaseline(base, { imdb: 'tt1000010', season: 2, episode: 1 }),
    false,
  );
});

test('mirror decision matrix: match, gates, and baseline', () => {
  const pairs = [tkPair(), angePair()];
  const pick = (clientId, item) => decideLiveMirror({ pairs, clientId, item });

  // TK pick, item in the baseline -> excluded.
  assert.equal(pick('tk-client', { imdb: 'tt1000001' }).action, 'excluded');
  assert.equal(
    pick('tk-client', { imdb: 'tt1000010', season: 1, episode: 1 }).action,
    'excluded',
  );
  // TK pick, item after the baseline -> post.
  const post = pick('tk-client', { imdb: 'tt1000002' });
  assert.equal(post.action, 'post');
  assert.equal(post.pair.name, 'TK');

  // Ange's config matches Ange's pair (Watch Together off) -> none,
  // even though her client_id is TK's pair's *mirror* client_id space:
  // matching is on pair.simkl.client_id only.
  assert.deepEqual(pick('ange-client', { imdb: 'tt1000002' }), {
    action: 'none',
    reason: 'watch-together-off',
    pair: pairs[1],
  });

  // No pair for this config -> none.
  assert.deepEqual(pick('stranger-client', { imdb: 'tt1000002' }), {
    action: 'none',
    reason: 'no-pair',
  });
  assert.deepEqual(pick(undefined, { imdb: 'tt1000002' }), {
    action: 'none',
    reason: 'no-pair',
  });

  // Watch Together on but pieces missing -> none.
  const noMirror = [tkPair({ mirrorSimkl: null })];
  assert.equal(
    decideLiveMirror({
      pairs: noMirror,
      clientId: 'tk-client',
      item: { imdb: 'tt1000002' },
    }).reason,
    'no-mirror-account',
  );
  const noBaseline = [tkPair({ watchTogetherBaseline: null })];
  assert.equal(
    decideLiveMirror({
      pairs: noBaseline,
      clientId: 'tk-client',
      item: { imdb: 'tt1000002' },
    }).reason,
    'no-baseline',
  );
  const badBaseline = [tkPair({ watchTogetherBaseline: { movies: [] } })];
  assert.equal(
    decideLiveMirror({
      pairs: badBaseline,
      clientId: 'tk-client',
      item: { imdb: 'tt1000002' },
    }).reason,
    'no-baseline',
  );
});

test('mirror payload matches the reconciler mirror shape', () => {
  assert.deepEqual(buildMirrorPayload({ imdb: 'tt1000002' }), {
    movies: [{ ids: { imdb: 'tt1000002' } }],
    shows: [],
  });
  assert.deepEqual(
    buildMirrorPayload({ imdb: 'tt1000010', season: 1, episode: 3 }),
    {
      movies: [],
      shows: [
        {
          ids: { imdb: 'tt1000010' },
          seasons: [{ number: 1, episodes: [{ number: 3 }] }],
        },
      ],
    },
  );
});

test('in-baseline pick logs the exclusion and posts nothing', async (t) => {
  const calls = [];
  const options = baseOptions(t, {
    postHistoryFn: recordingPostHistory(calls),
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000010', season: 1, episode: 2 },
  });
  assert.equal(result.action, 'excluded');
  assert.equal(calls.length, 0);
  assert.match(
    readDebugLog(options.dataDir),
    /\[live\] mirror excluded \(in baseline\) tt1000010 S1E2/,
  );
});

test('post-baseline pick posts to the mirror account and logs it', async (t) => {
  const calls = [];
  const options = baseOptions(t, {
    postHistoryFn: recordingPostHistory(calls),
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000010', season: 1, episode: 3 },
  });
  assert.equal(result.action, 'posted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth.access_token, 'mirror-token');
  assert.equal(calls[0].auth.client_id, 'mirror-client');
  assert.deepEqual(
    calls[0].payload,
    buildMirrorPayload({ imdb: 'tt1000010', season: 1, episode: 3 }),
  );
  assert.match(
    readDebugLog(options.dataDir),
    /\[live\] mirror posted tt1000010 S1E3 \(HTTP 201\)/,
  );
});

test('non-Watch-Together and unmatched picks stay completely silent', async (t) => {
  const calls = [];
  const options = baseOptions(t, {
    postHistoryFn: recordingPostHistory(calls),
  });
  const ange = await mirrorLivePick({
    ...options,
    clientId: 'ange-client',
    item: { imdb: 'tt1000002' },
  });
  const stranger = await mirrorLivePick({
    ...options,
    clientId: 'stranger-client',
    item: { imdb: 'tt1000002' },
  });
  assert.equal(ange.action, 'none');
  assert.equal(stranger.action, 'none');
  assert.equal(calls.length, 0);
  assert.equal(readDebugLog(options.dataDir), '');
});

test('Watch Together pair without a baseline mirrors nothing, silently', async (t) => {
  const calls = [];
  const options = baseOptions(t, {
    loadPairsFn: () => [tkPair({ watchTogetherBaseline: null }), angePair()],
    postHistoryFn: recordingPostHistory(calls),
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
  });
  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'no-baseline');
  assert.equal(calls.length, 0);
  assert.equal(readDebugLog(options.dataDir), '');
});

test('a 401 from the mirror refreshes the mirror token and retries once', async (t) => {
  const calls = [];
  const persisted = [];
  const newAuth = {
    access_token: 'mirror-token-new',
    client_id: 'mirror-client',
    refresh_token: 'mirror-refresh',
    expires_at: FAR_FUTURE,
  };
  const options = baseOptions(t, {
    postHistoryFn: recordingPostHistory(calls, (auth, payload, attempt) => {
      if (attempt === 1) {
        throw new HttpError(401, 'POST /sync/history: Simkl returned 401');
      }
    }),
    refreshAuthFn: async (auth) => {
      assert.equal(auth.access_token, 'mirror-token');
      return newAuth;
    },
    persistAuthFn: (name, target, auth) => persisted.push({ name, target, auth }),
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
  });
  assert.equal(result.action, 'posted');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth.access_token, 'mirror-token-new');
  assert.deepEqual(persisted, [
    { name: 'TK', target: 'mirrorSimkl', auth: newAuth },
  ]);
  assert.match(
    readDebugLog(options.dataDir),
    /\[live\] mirror posted tt1000002 \(HTTP 201\)/,
  );
});

test('a 401 with no mirror refresh token logs a clear failure, never throws', async (t) => {
  const options = baseOptions(t, {
    loadPairsFn: () => [
      tkPair({
        mirrorSimkl: {
          access_token: 'mirror-token',
          client_id: 'mirror-client',
          expires_at: FAR_FUTURE,
        },
      }),
      angePair(),
    ],
    postHistoryFn: async () => {
      throw new HttpError(401, 'POST /sync/history: Simkl returned 401');
    },
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
  });
  assert.equal(result.action, 'failed');
  assert.equal(result.reason, 'no-refresh-token');
  assert.match(
    readDebugLog(options.dataDir),
    /\[live\] mirror failed tt1000002 — Simkl returned 401 and no mirror refresh token is stored/,
  );
});

test('end to end: real pair store and real Simkl POST carry the mirror auth', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair(), angePair()], SECRET, dataDir);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, fetchOptions = {}) => {
    requests.push({ url: String(url), options: fetchOptions });
    return new Response(JSON.stringify({}), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await mirrorLivePick({
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
    secret: SECRET,
    dataDir,
  });

  assert.equal(result.action, 'posted');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.simkl.com/sync/history/');
  assert.equal(
    requests[0].options.headers.Authorization,
    'Bearer mirror-token',
  );
  assert.equal(requests[0].options.headers['simkl-api-key'], 'mirror-client');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    movies: [{ ids: { imdb: 'tt1000002' } }],
    shows: [],
  });
  assert.match(
    readDebugLog(dataDir),
    /\[live\] mirror posted tt1000002 \(HTTP 201\)/,
  );
});

test('DEBUG_LOG=0 silences the instant mirror lines too', async (t) => {
  const options = baseOptions(t);
  const previous = process.env.DEBUG_LOG;
  process.env.DEBUG_LOG = '0';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.DEBUG_LOG;
    } else {
      process.env.DEBUG_LOG = previous;
    }
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000001' },
  });
  assert.equal(result.action, 'excluded');
  assert.equal(existsSync(debugLogPath(options.dataDir)), false);
});

test("mirror posted line carries Simkl's confirmed added counts", async (t) => {
  const options = baseOptions(t, {
    postHistoryFn: async (auth, payload, onPost) => {
      if (onPost) {
        onPost({
          movies: payload.movies.length,
          shows: payload.shows.length,
          status: 201,
          added: { movies: 0, shows: 1, episodes: 1 },
        });
      }
      return { movies: payload.movies.length, shows: payload.shows.length };
    },
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000010', season: 1, episode: 3 },
  });
  assert.equal(result.action, 'posted');
  assert.match(
    readDebugLog(options.dataDir),
    /\[live\] mirror posted tt1000010 S1E3 \(HTTP 201\) — Simkl added 1 episode\(s\)/,
  );
});

test('mirror posted line is unchanged when Simkl reports no added counts', async (t) => {
  const calls = [];
  const options = baseOptions(t, {
    // recordingPostHistory's onPost carries no `added`, like a
    // /sync/history response without an `added` object.
    postHistoryFn: recordingPostHistory(calls),
  });
  const result = await mirrorLivePick({
    ...options,
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
  });
  assert.equal(result.action, 'posted');
  const logText = readDebugLog(options.dataDir);
  assert.match(logText, /\[live\] mirror posted tt1000002 \(HTTP 201\)\n/);
  assert.equal(logText.includes('Simkl added'), false);
});

test('end to end: real postHistory surfaces confirmed counts in the log', async (t) => {
  const dataDir = tempDir(t);
  savePairs([tkPair(), angePair()], SECRET, dataDir);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ added: { movies: 1, shows: 0, episodes: 0 } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await mirrorLivePick({
    clientId: 'tk-client',
    item: { imdb: 'tt1000002' },
    secret: SECRET,
    dataDir,
  });

  assert.equal(result.action, 'posted');
  assert.match(
    readDebugLog(dataDir),
    /\[live\] mirror posted tt1000002 \(HTTP 201\) — Simkl added 1 movie\(s\)/,
  );
});
