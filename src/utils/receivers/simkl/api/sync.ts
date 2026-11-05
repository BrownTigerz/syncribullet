import { writeDebugLog } from '~/reconciler/debug-log.mjs';
import { mirrorLivePick } from '~/reconciler/live-mirror.mjs';
import { decideLiveMark } from '~/reconciler/marking-modes.mjs';
import {
  formatAddedCounts,
  parseAddedCounts,
} from '~/reconciler/simkl.mjs';
import { axiosInstance } from '~/utils/axios/cache';
import type { IDs } from '~/utils/receiver/types/id';

import type { SimklUserSettings } from '../types/user-settings';
import { createSimklHeaders } from './headers';

// Debug-log label for one picked item: IMDb id plus season/episode for
// series. Never includes any part of the auth or the addon config.
function liveItemLabel(ids: {
  ids: Partial<IDs>;
  count: { season: number; episode: number } | undefined;
}): string {
  const imdb = ids.ids.imdb ? String(ids.ids.imdb) : 'unknown-id';
  return ids.count ? `${imdb} S${ids.count.season}E${ids.count.episode}` : imdb;
}

export async function syncSimklMetaObject(
  ids: {
    ids: Partial<IDs>;
    count:
      | {
          season: number;
          episode: number;
        }
      | undefined;
  },
  userConfig: SimklUserSettings,
): Promise<void> {
  if (!userConfig.auth) {
    throw new Error('No user config! This should not happen!');
  }

  const pickedItem = {
    imdb: ids.ids.imdb ? String(ids.ids.imdb) : undefined,
    season: ids.count?.season,
    episode: ids.count?.episode,
  };

  // Instant Watch Together mirror: if this pick's Simkl account is a
  // saved pair with Watch Together on, the same item is also posted
  // to the mirror account (baseline still enforced, in
  // ~/reconciler/live-mirror.mjs). Fire-and-forget on purpose: it is
  // never awaited, so the stream response is not delayed, and
  // mirrorLivePick never throws — the reconciler remains the safety
  // net for anything it misses. The pair is matched by this config's
  // own Simkl client_id; no config or token material is passed to
  // the log. Fired independently of the own-account write below: the
  // MIRROR_LIVE_MARK mode governs it, not LIVE_MARK.
  const fireMirror = () => {
    if (pickedItem.imdb) {
      void mirrorLivePick({
        clientId: userConfig.auth!.client_id,
        item: pickedItem,
      }).catch(() => {
        // mirrorLivePick is built to never reject; this is a last
        // guard so a mirror problem can never surface in a live pick.
      });
    }
  };

  // LIVE_MARK marking mode (.env): `movies` keeps episode picks off
  // the live write (they arrive via the reconciler once Stremio
  // flags them watched) and `off` makes this account reconciler-only.
  // Unset is the pre-switch behavior — everything marks at pick time
  // and no skip line is written.
  const liveMark = decideLiveMark(process.env, pickedItem);
  if (!liveMark.allowed) {
    writeDebugLog(
      'live',
      `live mark skipped for ${liveItemLabel(ids)} — LIVE_MARK=${liveMark.mode}`,
    );
    fireMirror();
    return;
  }

  let data: Record<string, any> = {
    title: undefined,
    ids: ids.ids,
  };

  if (ids.count) {
    data['seasons'] = [
      {
        number: ids.count.season,
        episodes: [
          {
            number: ids.count.episode,
          },
        ],
      },
    ];
    data = {
      shows: [data],
    };
  } else {
    data = {
      movies: [data],
    };
  }

  try {
    const response = await axiosInstance(`https://api.simkl.com/sync/history`, {
      method: 'POST',
      headers: createSimklHeaders(userConfig.auth),
      data,
    });
    // Simkl's response reports what it actually marked (`added`
    // counts); surface them in the log line when present, counts only.
    const confirmed = formatAddedCounts(parseAddedCounts(response.data));
    writeDebugLog(
      'live',
      `stream pick — Simkl write posted for ${liveItemLabel(ids)} (HTTP ${response.status})${confirmed ? ` — ${confirmed}` : ''}`,
    );
    fireMirror();
    return await response.data;
  } catch (e) {
    const err = e as { response?: { status?: number }; message?: string };
    const status = err.response?.status;
    writeDebugLog(
      'live',
      `stream pick — Simkl write FAILED for ${liveItemLabel(ids)}${
        status ? ` (HTTP ${status})` : ''
      } — ${err.message || 'unknown error'}`,
    );
    console.error(e);
    throw new Error('Failed to fetch data from Simkl API!');
  }
}
