// Marking-mode switches for the live (stream-pick) write paths.
//
// Two .env variables, same pattern as the WATCH_TOGETHER solo/together
// switch (watch-together-baseline.mjs): read from the env, parsed by
// one shared helper, and an unset or unrecognized value means "no
// override" — the build behaves exactly as it did before the switches
// existed, and no new log lines appear.
//
//   LIVE_MARK         — the pick-time live write to the picker's OWN
//                       Simkl account (the fork addon path,
//                       src/utils/receivers/simkl/api/sync.ts).
//   MIRROR_LIVE_MARK  — the INSTANT Watch Together mirror at pick
//                       time (live-mirror.mjs). Never affects the
//                       reconciler's mirror pass, which stays
//                       watched-flag-based on its schedule.
//
// Values for both:
//   all     (default) — movies and episodes mark at pick time.
//   movies            — movies mark at pick time; episodes do not
//                       (they arrive via the reconciler once Stremio
//                       flags them watched).
//   off               — nothing marks at pick time; the reconciler
//                       is the only writer.

const MARKING_MODES = new Set(['all', 'movies', 'off']);

/**
 * Parse one marking-mode value. Returns 'all' | 'movies' | 'off', or
 * null for unset / empty / unrecognized (no override — never a guess).
 * Case-insensitive, surrounding whitespace ignored.
 */
export function parseMarkingMode(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return MARKING_MODES.has(normalized) ? normalized : null;
}

/** The LIVE_MARK override from an env bag (default process.env). */
export function liveMarkMode(env = process.env) {
  return parseMarkingMode(env?.LIVE_MARK);
}

/** The MIRROR_LIVE_MARK override from an env bag (default process.env). */
export function mirrorLiveMarkMode(env = process.env) {
  return parseMarkingMode(env?.MIRROR_LIVE_MARK);
}

/** Is this picked item an episode (season and episode both present)? */
export function isEpisodePick(item) {
  return Number.isFinite(item?.season) && Number.isFinite(item?.episode);
}

/**
 * Does a parsed marking mode allow marking this item at pick time?
 * A null mode (unset/invalid) is the pre-switch behavior: everything
 * is allowed and callers add no skip lines.
 */
export function markingModeAllows(mode, item) {
  if (mode === null || mode === 'all') {
    return true;
  }
  if (mode === 'off') {
    return false;
  }
  // 'movies': movies only.
  return !isEpisodePick(item);
}

/**
 * The own-account live-mark decision for one pick:
 *   { allowed: true, mode }            — write as usual
 *   { allowed: false, mode }           — skip the live write; the
 *                                        caller logs one skip line
 *                                        naming the mode (the mode is
 *                                        non-null whenever allowed is
 *                                        false).
 */
export function decideLiveMark(env, item) {
  const mode = liveMarkMode(env);
  return { allowed: markingModeAllows(mode, item), mode };
}
