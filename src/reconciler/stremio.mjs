// Headless Stremio library access for the reconciler.
// Mirrors src/utils/importers/stremio (datastoreGet for the full library,
// watched = flaggedWatched || timesWatched, episodes from the Cinemeta
// watched bitfield) without any browser/Qwik dependencies.

import { WatchedBitField } from './bitfield.mjs';

const DATASTORE_URL = 'https://api.strem.io/api/datastoreGet';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fetch the full libraryItem collection for a Stremio authKey. */
export async function fetchStremioLibrary(authKey) {
  const response = await fetch(DATASTORE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authKey,
      collection: 'libraryItem',
      ids: [],
      all: true,
    }),
  });
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Stremio datastoreGet failed: ${response.status}`,
    );
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.result)) {
    throw new Error('Stremio datastoreGet returned an unexpected shape');
  }
  return data.result;
}

const metaCache = new Map();

/** Cinemeta episode list for a series: [{ id, season, episode }]. */
export async function fetchSeriesVideos(showId) {
  if (metaCache.has(showId)) {
    return metaCache.get(showId);
  }
  const response = await fetch(
    `${CINEMETA_URL}/series/${encodeURIComponent(showId)}.json`,
  );
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Cinemeta meta fetch failed for ${showId}: ${response.status}`,
    );
  }
  const data = await response.json();
  const videos = (data?.meta?.videos || [])
    .map((video) => ({
      id: video.id,
      season: video.season,
      episode: video.episode,
    }))
    .filter((video) => typeof video.season === 'number');
  metaCache.set(showId, videos);
  return videos;
}

const IMDB_ID = /^tt\d+$/;

/**
 * Reduce raw library items to watched state:
 * {
 *   movies: Map<imdbId, { title }>,
 *   shows:  Map<imdbId, { title, episodes: Set<'season:episode'> }>,
 *   skipped: number,    // watched items not included in the result
 *   unresolved: number  // skipped items that might resolve on a later run
 *                       // (out-of-scope non-IMDb items are skipped, not
 *                       // unresolved — they can never enter the diff)
 *   skippedItems: [{ id, type, reason, unresolved }]  // per-item detail
 *                       // for every skipped item, for the debug log
 * }
 *
 * Episodes come from the Cinemeta watched bitfield whenever Stremio
 * recorded one, so episodes the user skipped are NOT marked. Without a
 * bitfield, episodes up to the recorded last-watched season/episode are
 * used (Stremio's own state.season/state.episode). Items without an IMDb
 * id (anime via kitsu/mal ids, etc.) are out of scope and counted as
 * skipped.
 */
export async function extractWatched(libraryItems, log = console) {
  const movies = new Map();
  const shows = new Map();
  let skipped = 0;
  let unresolved = 0;
  const skippedItems = [];
  const noteSkipped = (item, reason, isUnresolved) => {
    skipped++;
    if (isUnresolved) {
      unresolved++;
    }
    skippedItems.push({
      id: item?._id ?? null,
      type: item?.type ?? null,
      reason,
      unresolved: !!isUnresolved,
    });
  };

  for (const item of libraryItems) {
    if (!item || item.removed) {
      continue;
    }
    const state = item.state || {};
    const watched = !!state.flaggedWatched || !!state.timesWatched;
    if (!watched) {
      continue;
    }
    const showOrMovieId = String(item._id || '').split(':')[0];
    if (!IMDB_ID.test(showOrMovieId)) {
      noteSkipped(item, `non-IMDb id "${showOrMovieId}"`, false);
      continue;
    }

    if (item.type === 'movie') {
      movies.set(showOrMovieId, { title: item.name });
      continue;
    }

    if (item.type !== 'series') {
      noteSkipped(item, `unsupported type "${item.type}"`, false);
      continue;
    }

    let videos;
    try {
      videos = await fetchSeriesVideos(showOrMovieId);
    } catch (e) {
      log.warn(
        `[reconciler] Could not load episode list for ${showOrMovieId} (${item.name}): ${e.message}. Skipping this run; it will be retried.`,
      );
      noteSkipped(
        item,
        `episode list fetch failed: ${e.message}`,
        true,
      );
      continue;
    }
    if (videos.length === 0) {
      noteSkipped(item, 'Cinemeta returned no episodes for this series', true);
      continue;
    }

    const episodes = new Set();
    if (state.watched) {
      try {
        const videoIds = videos.map((video) => video.id);
        const bitfield = WatchedBitField.constructAndResize(
          state.watched,
          videoIds,
        );
        for (const video of videos) {
          if (bitfield.getVideo(video.id)) {
            episodes.add(`${video.season}:${video.episode}`);
          }
        }
      } catch (e) {
        log.warn(
          `[reconciler] Could not parse watched bitfield for ${showOrMovieId} (${item.name}): ${e.message}`,
        );
      }
    }

    if (episodes.size === 0) {
      // No usable bitfield: fall back to Stremio's last-watched pointer.
      const lastSeason = state.season;
      const lastEpisode = state.episode;
      if (typeof lastSeason === 'number' && typeof lastEpisode === 'number') {
        for (const video of videos) {
          if (video.season < 1) {
            continue; // specials are only marked via the bitfield
          }
          if (
            video.season < lastSeason ||
            (video.season === lastSeason && video.episode <= lastEpisode)
          ) {
            episodes.add(`${video.season}:${video.episode}`);
          }
        }
      }
    }

    if (episodes.size === 0) {
      noteSkipped(item, 'no watched episodes resolved', true);
      continue;
    }
    shows.set(showOrMovieId, { title: item.name, episodes });
  }

  return { movies, shows, skipped, unresolved, skippedItems };
}
