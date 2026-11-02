import type { RequestHandler } from '@builder.io/qwik-city';

import {
  loadPairs,
  readStatus,
  upsertPair,
} from '~/reconciler/pairs-store.mjs';
import type { SimklStremioPair } from '~/reconciler/pairs-store.mjs';

const getSecret = (env: { get: (key: string) => string | undefined }) => {
  const secret = env.get('PRIVATE_ENCRYPTION_KEY');
  if (!secret) {
    // Deliberately no fallback to the app's FPE literal key: pair tokens
    // must never be encrypted with a publicly known key.
    throw new Error('PRIVATE_ENCRYPTION_KEY is not set on the server');
  }
  return secret;
};

const badRequest = (json: (status: number, data: unknown) => void, msg: string) =>
  json(400, { ok: false, error: msg });

/**
 * Pair list for the configure page: names and run status only.
 * Tokens are never returned to the browser.
 */
export const onGet: RequestHandler = async ({ json, env }) => {
  let pairs: SimklStremioPair[] = [];
  try {
    pairs = loadPairs(getSecret(env));
  } catch (e) {
    json(500, { ok: false, error: (e as Error).message });
    return;
  }
  const status = readStatus() as {
    pairs?: Record<string, Record<string, unknown>>;
  };
  json(200, {
    ok: true,
    pairs: pairs.map((pair) => ({
      name: pair.name,
      updatedAt: pair.updatedAt,
      watchTogether: !!pair.watchTogether,
      hasMirror: !!pair.mirrorSimkl,
      status: status.pairs?.[pair.name] || null,
    })),
  });
};

/**
 * Save (or replace) a pair for the server-side reconciler.
 * Body: { name, stremioAuthKey, simkl: {access_token, client_id,
 * refresh_token?, expires_at?}, watchTogether?, mirrorSimkl? }
 * Stored in /app/data/pairs.json, AES-256-GCM encrypted.
 */
export const onPost: RequestHandler = async ({ json, env, parseBody }) => {
  const body = (await parseBody()) as Partial<SimklStremioPair> | null;

  if (!body || typeof body !== 'object') {
    badRequest(json, 'Missing request body');
    return;
  }
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    badRequest(json, 'A pair name is required');
    return;
  }
  if (!body.stremioAuthKey) {
    badRequest(json, 'Stremio is not connected (no authKey)');
    return;
  }
  if (!body.simkl?.access_token || !body.simkl?.client_id) {
    badRequest(json, 'Simkl is not connected');
    return;
  }
  if (
    body.watchTogether &&
    (!body.mirrorSimkl?.access_token || !body.mirrorSimkl?.client_id)
  ) {
    badRequest(
      json,
      'Watch Together is on but the mirror Simkl account is not connected',
    );
    return;
  }

  const pair: SimklStremioPair = {
    name: body.name.trim(),
    stremioAuthKey: body.stremioAuthKey,
    simkl: {
      access_token: body.simkl.access_token,
      client_id: body.simkl.client_id,
      refresh_token: body.simkl.refresh_token,
      expires_at: body.simkl.expires_at,
    },
    watchTogether: !!body.watchTogether,
    mirrorSimkl: body.mirrorSimkl
      ? {
          access_token: body.mirrorSimkl.access_token,
          client_id: body.mirrorSimkl.client_id,
          refresh_token: body.mirrorSimkl.refresh_token,
          expires_at: body.mirrorSimkl.expires_at,
        }
      : null,
  };

  try {
    upsertPair(pair, getSecret(env));
  } catch (e) {
    json(500, { ok: false, error: (e as Error).message });
    return;
  }
  json(200, { ok: true });
};
