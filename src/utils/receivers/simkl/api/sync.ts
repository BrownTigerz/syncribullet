import { writeDebugLog } from '~/reconciler/debug-log.mjs';
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
    writeDebugLog(
      'live',
      `stream pick — Simkl write posted for ${liveItemLabel(ids)} (HTTP ${response.status})`,
    );
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
