import type { RequestHandler } from '@builder.io/qwik-city';

import {
  RemoveHistoryError,
  removeHistoryItem,
} from '~/reconciler/remove-history.mjs';

const getSecret = (env: { get: (key: string) => string | undefined }) => {
  const secret = env.get('PRIVATE_ENCRYPTION_KEY');
  if (!secret) {
    // Deliberately no fallback to the app's FPE literal key: pair tokens
    // must never be encrypted with a publicly known key.
    throw new Error('PRIVATE_ENCRYPTION_KEY is not set on the server');
  }
  return secret;
};

/**
 * Remove ONE item from ONE Simkl history — the manual undo behind the
 * configure page's "Remove From Simkl History" section.
 * Body: { pairName, target: 'own' | 'mirror', imdb, season?, episode? }
 *
 * Deliberate and per-item only: there is no batch form of this route
 * and nothing automatic calls it. Like /api/pairs it has no login of
 * its own — LAN only, never expose this server publicly.
 */
export const onPost: RequestHandler = async ({ json, env, parseBody }) => {
  let secret: string;
  try {
    secret = getSecret(env);
  } catch (e) {
    json(500, { ok: false, error: (e as Error).message });
    return;
  }

  const body = await parseBody();
  try {
    const result = await removeHistoryItem({ body, secret });
    json(200, result);
  } catch (e) {
    if (e instanceof RemoveHistoryError) {
      json(e.status, { ok: false, error: e.message });
    } else {
      json(500, { ok: false, error: (e as Error).message });
    }
  }
};
