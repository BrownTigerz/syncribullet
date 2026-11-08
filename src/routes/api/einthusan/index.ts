import type { RequestHandler } from '@builder.io/qwik-city';

import {
  EinthusanError,
  einthusanClearMatch,
  einthusanGetMatch,
  einthusanMark,
  einthusanSaveMatch,
  einthusanSearch,
} from '~/reconciler/einthusan.mjs';

const getSecret = (env: { get: (key: string) => string | undefined }) => {
  const secret = env.get('PRIVATE_ENCRYPTION_KEY');
  if (!secret) {
    // Same rule as /api/pairs: pair tokens must never be touched
    // without the server's real encryption key.
    throw new Error('PRIVATE_ENCRYPTION_KEY is not set on the server');
  }
  return secret;
};

type JsonFn = (status: number, data: unknown) => void;

const respond = async (json: JsonFn, run: () => Promise<unknown>) => {
  try {
    json(200, await run());
  } catch (e) {
    if (e instanceof EinthusanError) {
      json(e.status, { ok: false, error: e.message });
    } else {
      json(500, { ok: false, error: (e as Error).message });
    }
  }
};

/**
 * Einthusan → Simkl tracker API, driven by TK's Brave extension.
 *
 * GET  ?action=search&pair=<name>&q=<title>  Simkl movie candidates
 * GET  ?action=match&site=<einthusan id>     the saved match, or null
 * POST { action: 'save-match', siteId, match }   save a confirmed match
 * POST { action: 'clear-match', siteId }         clear a saved match
 * POST { action: 'mark', pairName, siteId }      mark the saved match
 * DELETE ?site=<einthusan id>                    clear a saved match
 *
 * Marks land on the named pair's own Simkl. When the saved match
 * carries the extension's Together choice, the mark response also
 * reports the mirror outcome for the pair's stored mirror account;
 * that choice lives in the extension and is independent of the
 * Stremio-side Watch Together settings. Like /api/pairs and
 * /api/remove-history this route has no login of its own — LAN
 * only, never expose this server publicly.
 */
export const onGet: RequestHandler = async ({ json, env, query }) => {
  const action = query.get('action') || '';
  if (action === 'search') {
    let secret: string;
    try {
      secret = getSecret(env);
    } catch (e) {
      json(500, { ok: false, error: (e as Error).message });
      return;
    }
    await respond(json, () =>
      einthusanSearch({
        pairName: query.get('pair') || '',
        query: query.get('q') || '',
        secret,
      }),
    );
    return;
  }
  if (action === 'match') {
    await respond(json, async () =>
      einthusanGetMatch({ siteId: query.get('site') || '' }),
    );
    return;
  }
  json(400, { ok: false, error: 'Unknown action — use search or match' });
};

export const onPost: RequestHandler = async ({ json, env, parseBody }) => {
  const body = (await parseBody()) as {
    action?: string;
    pairName?: string;
    siteId?: string;
    match?: unknown;
  } | null;
  if (!body || typeof body !== 'object' || !body.action) {
    json(400, { ok: false, error: 'Missing request body or action' });
    return;
  }

  if (body.action === 'save-match') {
    await respond(json, async () =>
      einthusanSaveMatch({ siteId: body.siteId || '', match: body.match }),
    );
    return;
  }
  if (body.action === 'clear-match') {
    await respond(json, async () =>
      einthusanClearMatch({ siteId: body.siteId || '' }),
    );
    return;
  }
  if (body.action === 'mark') {
    let secret: string;
    try {
      secret = getSecret(env);
    } catch (e) {
      json(500, { ok: false, error: (e as Error).message });
      return;
    }
    await respond(json, () =>
      einthusanMark({
        pairName: body.pairName || '',
        siteId: body.siteId || '',
        secret,
      }),
    );
    return;
  }
  json(400, {
    ok: false,
    error: 'Unknown action — use save-match, clear-match, or mark',
  });
};

export const onDelete: RequestHandler = async ({ json, query }) => {
  await respond(json, async () =>
    einthusanClearMatch({ siteId: query.get('site') || '' }),
  );
};
