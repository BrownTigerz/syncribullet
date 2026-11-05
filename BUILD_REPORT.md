# Build Report — SimklStremio Fork

Branch: `build/simklstremio` (local commits only, never pushed).
Base: upstream `1415a46`. Audience: TK, for `E:\Projects\SimklStremio`.
Setup steps live in SETUP.md. Auth research lives in docs/SIMKL_AUTH.md.

## Correction — Watch Together Baseline

Commit: this correction commit on `build/simklstremio`, on top of
`e8cca81`. It supersedes the original Watch Together behavior described
in the first build: the mirror no longer receives TK's full watched
history.

- Watch Together is prospective only. When a pair is saved with Watch
  Together turning on, `POST /api/pairs` uses the pair's Stremio
  authKey to fetch the current watched movies and episodes and stores
  them in the pair record as `watchTogetherBaseline` (movie IMDb ids;
  episode keys as `season:episode` per show IMDb id; plus
  `capturedAt`). See `src/reconciler/watch-together-baseline.mjs`.
- A plain re-save while Watch Together is already on keeps the stored
  baseline — it never moves forward. Saving with Watch Together off
  drops the baseline. Saving off first and then on again captures a
  new starting point.
- If the baseline cannot be captured completely, the save fails and
  the pair is not stored. A stored Watch Together pair always has a
  baseline from this flow.
- The mirror pass now posts only `(current watched set - baseline)`,
  diffed again against the mirror account's own Simkl library. The
  pair's own Stremio -> Simkl reconcile is unchanged and still uses the
  full state diff, so pre-baseline items still reach TK's own Simkl.
- Legacy or damaged pair records with Watch Together on but no valid
  baseline mirror nothing and are flagged `needsBaseline` in
  status.json. There is no full-history fallback anywhere.

Correction gates: `npm run build` passes (type check and lint);
`npm run test:reconciler` passes 12/12, including the four mirror
cases (baseline item not mirrored, post-baseline item mirrored,
no-baseline mirrors nothing and flags `needsBaseline`, and the pair's
own full diff still posts pre-baseline items to its own Simkl); the
server smoke test passes, including a Watch Together save with an
unusable Stremio key returning 502 and storing nothing.

## Phase 1 — Simkl AUTH V2 Findings (Short Version)

- Stock Simkl login is dead for new apps: Simkl's portal now issues
  OAuth 2.0 (AUTH V2) apps and refuses the legacy PIN endpoint for them
  (`unauthorized_client`: "use POST /oauth2/device instead of
  /oauth/pin").
- The OAuth 2.0 **device flow** works for V2 apps and needs no redirect
  URI: `POST /oauth2/device` returns a `user_code`; the user approves at
  simkl.com/pin; the app polls `POST /oauth2/token` and receives an
  access token (7 days) **and** a refresh token (180 days, sliding,
  non-rotating). Refresh is a standard `grant_type=refresh_token` call.
- V2 tokens work on the `/sync/*` endpoints with the headers the code
  already sends (`Authorization: Bearer <token>`, `simkl-api-key:
  <client_id>`). Full contract, error table, and citations:
  docs/SIMKL_AUTH.md.
- One grant = one live access token: refreshing replaces the token
  immediately. Whoever refreshes must own the grant (see Caveats).

## What Changed, File By File

Base fixes:

- `Dockerfile.local` — build stage already installs with `npm ci` in
  this tree (the `--omit=dev` failure was verified on TK's PC against
  the stock file); entrypoint now also starts the reconciler beside
  the web server; `/app/data` is created and owned by `appuser`.
- `package.json` — `start:local` now uses
  `ORIGIN=${APP_ORIGIN:-http://127.0.0.1:3000}` instead of the hardcoded
  port 3000 (which sent return traffic to BookOrbit's port). Added
  `start:reconciler`.
- `src/utils/importer/importer.ts` — watermark bug: `startImport` now
  awaits `_startImport`, so failures propagate and `lastImport` only
  advances after a confirmed success.
- `src/utils/receivers/simkl/constants.ts` — completed-only defaults:
  the plan-to-watch / watching / on-hold / dropped Stremio import
  catalogs for Simkl now default off; completed catalogs stay on. The
  `/sync/add-to-list` caller in the Simkl importer stays commented out
  (stock state) — list writes are never made.

Simkl AUTH V2 login:

- `src/components/forms/simkl-login.tsx` — rewritten for the device
  flow: enter Client Id → Get Code → code shown with a Validate button
  that opens Simkl's approval page in a new tab → the page polls and
  completes the connection itself. Stores `{access_token, client_id,
  refresh_token, expires_at}` in the existing receiver auth shape.
  Also exports the `startDeviceAuth` / `pollDeviceAuth` server calls
  reused by the mirror sign-in.
- `src/routes/oauth/simkl/index.tsx` — no longer exchanges a PIN; it
  completes a pending device claim if the user lands there, then
  returns to the configure page.
- `src/utils/receivers/simkl/types/auth.ts` — preauth shape is now
  `{device_code, user_code?, client_id?}`.
- `src/utils/receivers/simkl/types/user-settings.ts` and
  `src/utils/receivers/simkl/types/manifest.ts` — auth gains optional
  `refresh_token` and `expires_at`. The install-URL serialization
  carries the auth object verbatim, so the new fields flow through.

Reconciler and pair saving (new code):

- `src/reconciler/pairs-store.mjs` + `types.ts` — pair storage in
  `/app/data/pairs.json`, AES-256-GCM encrypted, key derived from
  `PRIVATE_ENCRYPTION_KEY` (scrypt). Deliberately not the stock FPE
  scheme, and no fallback literal key: no key, no pair saving.
  status.json read/write helpers live here too.
- `src/reconciler/bitfield.mjs` — faithful plain-JS port of the app's
  `WatchedBitField` (uses the declared `pako` dependency) so episode
  extraction matches the importer exactly.
- `src/reconciler/stremio.mjs` — full library via datastoreGet; watched
  = `flaggedWatched || timesWatched`; episodes from the Cinemeta
  watched bitfield (skips preserved); fallback to the recorded
  last-watched season/episode when no bitfield exists; non-IMDb items
  skipped and counted.
- `src/reconciler/simkl.mjs` — library read via
  `GET /sync/all-items/?extended=full&include_all_episodes=original`
  (per-episode watched rows), diff helpers, chunked
  `POST /sync/history`, and the V2 refresh call. No delete/remove or
  add-to-list call exists in this file by design.
- `src/reconciler/reconcile.mjs` — the runner (see below).
- `src/reconciler/watch-together-baseline.mjs` — Watch Together
  starting-point snapshots: capture, save-flow keep/drop rules, and
  subtraction for the mirror pass (added by the correction above).
- `tests/reconciler.test.mjs` — the headless reconciler test suite,
  run with `npm run test:reconciler`.
- `scripts/reconciler.mjs` — headless entry point.
- `src/routes/api/pairs/index.ts` — `POST /api/pairs` validates and
  saves a pair, resolving the Watch Together baseline (capture, keep,
  or drop) before anything is stored; `GET /api/pairs` returns pair
  names, baseline presence/capture time, and run status only, never
  tokens.
- `src/components/sections/save-pair/save-pair-section.tsx` — the
  "Save Pair To Server" section on the configure page: reads the
  browser's current Stremio (link-flow authKey) and Simkl connections,
  pair name, Watch Together toggle, and the mirror Simkl sign-in (a
  second device flow, labelled as the mirror account). Rendered from
  `src/components/sections/configure.tsx`.
- `docker-compose.yml`, `.env.example`, `.gitignore` (`.env`, `/data`)
  — packaging per SETUP.md: host port 8181, `APP_ORIGIN` set from the
  host port, `./data:/app/data` bind mount, restart unless-stopped.
- `docs/SIMKL_AUTH.md`, `SETUP.md`, this report.

Other receivers (AniList, Kitsu, TVTime, MDBList) are untouched apart
from the shared importer await fix, which only makes failures report
correctly.

## How The Reconciler Works

- Started by the container entrypoint alongside the web server. Runs
  once at startup, then every `RECONCILE_INTERVAL_MINUTES` (default
  30).
- Per saved pair, every run: fetch the pair's full Stremio library,
  extract watched movies and watched episodes, fetch that Simkl
  account's actual full library, diff, and `POST /sync/history` only
  for what Simkl is missing. No watermark or local ledger decides
  anything — a full state diff is what makes downtime safe: miss a
  week of runs and the next run backfills the whole week.
- Watch Together: if the pair has it on and a mirror Simkl connection
  is saved, only the watched items added since the pair's stored
  starting-point baseline are diffed against the mirror account's own
  library and posted there. With no valid baseline, the mirror pass is
  skipped and the pair is flagged `needsBaseline`.
- Token lifecycle: if the access token is inside its last day (or a
  call returns 401), the reconciler refreshes it with the stored
  refresh token, persists the new token into pairs.json, and retries
  once. If refresh fails, the pair is marked `needsReauth` in
  status.json and the run stops for that pair; other pairs continue.
- A failed run changes no synced state and is retried next run.
  status.json records per pair: last run, last success, added
  movie/episode counts (primary and mirror), skipped count,
  `needsReauth`, `needsBaseline`, last error.

## Gate Results (This VM)

- `npm run build` — **pass** (exit 0: type check ✓, lint ✓, client and
  server bundles built).
- `npx tsc --noEmit` — **pass**, zero errors.
- Reconciler module tests (headless, stubbed network) —
  **12/12 pass** (`npm run test:reconciler`): encrypted store
  roundtrip (no plaintext tokens on disk, wrong key throws, upsert,
  auth update), Simkl library parsing (completed movies, per-episode
  rows, last-watched fallback, completed show), bitfield roundtrip
  (skipped episode stays unwatched), watched extraction
  (removed/unwatched ignored, non-IMDb counted as skipped), zero-pair
  run writes status.json, baseline snapshot/subtraction and save-flow
  rules (capture on enable, keep on re-save, drop when off, partial
  capture fails), and the four Watch Together mirror cases from the
  correction section.
- Local server smoke test (built server) — configure page returns 200
  and renders the Save Pair To Server section; `GET /api/pairs` 200;
  `POST /api/pairs` with a well-formed Watch Together-off body 200 and
  the pair lists back with metadata only, including
  `hasWatchTogetherBaseline: false`; stored pairs.json contains no
  plaintext token; a Watch Together-on save whose Stremio key cannot
  be read returns 502 and stores nothing. Reconciler entry boots, runs
  once against an empty data dir, writes status.json.
- Docker — **not available in this VM** (`docker` not installed), so
  the image build itself is gated on TK's PC.

## Caveats And Known Limits

- **Shared-grant refresh:** the pair's server copy and the browser /
  install-link copy come from the same Simkl authorization. When the
  reconciler refreshes (at least weekly, since access tokens live 7
  days), the token inside an already-installed addon link and the
  browser's saved connection go stale. Effect: Stremio catalogs from
  the addon may stop loading until Simkl is reconnected in the browser
  and the addon link reinstalled. Pair syncing itself is unaffected —
  the server copy is the one that stays fresh. A cleaner split (a
  separate Simkl authorization just for the server) is a follow-up,
  not in this build.
- **LAN addressing:** install links are generated from the address in
  the browser. Links made from the PC's LAN address work on the home
  network only (the server is home-only anyway). The Simkl sign-in has
  no redirect, so there is no origin matching problem on the Simkl
  side. SETUP.md spells out which address each person uses.
- **No login on the pair API:** anyone who can reach the configure
  page can save a pair. Home LAN only; do not port-forward.
- **Over-marking guard:** episodes come from Stremio's own watched
  bitfield. The known stock caveat (bitfield comparison drifting when
  Cinemeta's episode list changes) applies equally here; when no
  bitfield exists, the fallback marks episodes up to the last-watched
  pointer, never beyond it.
- Process note: `src/reconciler/simkl.mjs` was damaged by an automated
  secret-redaction during development (an Authorization header literal
  was scrubbed) and repaired; the final state is what the gates above
  ran against.

## What Remains Untested (Needs TK's Real Accounts / PC)

- End-to-end device approval against a real AUTH V2 Simkl app, for a
  primary and a mirror connection.
- A live reconcile against real Stremio + Simkl accounts (real
  datastore, Cinemeta, and `/sync/history` writes — no real tokens
  exist in this VM and none were fabricated).
- Docker image build and compose run on the Windows PC.
- Addon install in Stremio Kai from the generated link, and live sync
  through it.
- Ange's pair setup from her laptop over the LAN, and a live Watch
  Together mirror run.

## Debug Logger (Added 2026-11-02)

Built after a live debugging session where a test watch did not mirror
to the Watch Together account and the existing output — one summary
line per reconcile run on stdout, plus counts in status.json — could
not show which decision went which way for a single item.

**Files Changed**

- `src/reconciler/debug-log.mjs` (new): shared writer. Appends
  `YYYY-MM-DDTHH:mm:ss.sssZ [scope] message` lines to `debug.log` in
  the data dir, resolved exactly like the pairs store (`DATA_DIR` env
  override, else `./data`). Rolls to `debug.log.1` past ~5 MB. Default
  on, `DEBUG_LOG=0` disables. Every fs operation is wrapped so a
  logging failure can never throw into a caller; a missing or
  read-only data dir is a silent no-op. The Qwik server imports this
  same module, so the reconciler and the web server write one identical
  file with one identical format.
- `src/reconciler/reconcile.mjs`: run start/end lines; per-pair Stremio
  fetch and extraction counts; per-item decisions from the diff
  (`added`, `already on Simkl`); token refresh attempts and outcomes,
  401 handling, and needsReauth decisions; run-level errors with stack.
  Watch Together per pair: whether a baseline is present (capturedAt,
  movie/episode counts), per-item `excluded (in baseline)`,
  `excluded (already on mirror library)`, and `posted to mirror`
  lines, and the needsBaseline and no-mirror-account cases. The
  existing one-line stdout summaries are unchanged, so
  `docker compose logs` shows the same output as before.
- `src/reconciler/stremio.mjs`: `extractWatched` now also returns
  `skippedItems` — raw library item id, type, and reason for every
  skip, following the existing skipped/unresolved taxonomy
  (non-IMDb id, unsupported type, episode-list fetch failure, no
  episodes from Cinemeta, no watched episodes resolved).
- `src/reconciler/simkl.mjs`: `postHistory` takes an optional
  per-chunk callback reporting item counts and HTTP status, so each
  `/sync/history` write is recorded.
- `src/routes/[config]/subtitles/[...catchall]/index.tsx`: the live
  stream-pick dispatch now logs each pick — item IMDb id (plus
  season:episode for series), the receivers a write was attempted for,
  and each write's outcome — plus the no-usable-ids and no-matching-
  receiver early exits. The addon config is identified only by the
  first 8 hex characters of its SHA-256; the raw config segment (a
  bearer secret) is never written.
- `src/utils/receivers/simkl/api/sync.ts`: the Simkl live write logs
  its own result — posted with HTTP status, or failed with HTTP
  status/error.

**Design Choices**

- One file, `data\debug.log`, next to `pairs.json` and `status.json`,
  so it can be opened in Notepad and sent as-is when a watch does not
  land. No new service, port, or dependency.
- No secrets, by rule enforced at the call sites: no Simkl tokens, no
  Stremio authKeys, no encrypted pair data, no addon config strings.
  Only IMDb/item IDs, counts, HTTP status codes, pair names, and the
  config hash marker above. (Simkl client IDs are public by design;
  none are logged anyway.)
- The Watch Together mirror has no live path in this fork (it is
  reconciler-only), so `live` scope lines cover the primary receivers
  in the addon config; mirror decisions appear under `mirror:<pair>`
  on reconcile runs.
- No behaviour change: sync decisions, payloads, status.json, and pair
  storage are untouched. Applying this build needs only
  `docker compose up -d --build` — no pair re-save, no re-setup.

## Instant Mirror (Added 2026-11-02)

Follow-up to a live session on 2026-11-02: Watch Together itself was
proven working (baseline captured 8:31 PM MST, mirror attached to
Ange's account), but a together watch only reached Ange's Simkl at
the next reconciler run, because mirroring was reconciler-only — the
Debug Logger section above records that as the design at the time.
TK asked for the mirror to land instantly, like his own Simkl
marking. This build adds that fast path. The reconciler mirror pass
is unchanged and remains the mechanism of record.

**Design**

- Trigger point: `syncSimklMetaObject`
  (`src/utils/receivers/simkl/api/sync.ts`) — the one place a live
  Simkl write is known to have happened (it runs only after the
  receiver's live-sync type filter passes, and only for the subtitles
  stream-pick route). After the primary POST is confirmed, it fires
  the mirror without awaiting it: the stream/subtitles response is
  never delayed by the mirror, and the mirror call is built to never
  throw or reject into the caller.
- Pair matching: by Simkl **client_id**. Each person has their own
  Simkl app (SETUP.md Step 4); the addon config that made the pick
  carries that app's client_id in its Simkl auth, and the saved pair
  stores the same value in `pair.simkl.client_id`. The access token
  cannot be the key — the config holds its own grant, and the pair's
  stored token is refreshed and replaced over time — while the
  client_id is stable for the life of the app. Matching is against
  `pair.simkl.client_id` only, never `pair.mirrorSimkl.client_id`:
  Ange's picks therefore match Ange's pair (Watch Together off) and
  mirror nothing, and can never match TK's pair through its mirror
  credentials.
- Gates, in order: a pair matched; Watch Together on; a mirror
  account connected; a valid stored baseline
  (`isWatchTogetherBaseline`). Any gate failing means the pick is not
  a Watch Together pick and nothing is logged — ordinary picks stay
  silent in the log. The baseline is then enforced on the single
  item with the reconciler's own scheme (movie = IMDb id in
  `baseline.movies`; episode = `season:episode` key in
  `baseline.shows[imdb]`); an in-baseline pick logs
  `[live] mirror excluded (in baseline) <ttid> [S<s>E<e>]` and stops.
- Post: the single item is sent with the reconciler's `postHistory`
  (`src/reconciler/simkl.mjs`), same payload shape as the reconciler
  mirror, and logged as `[live] mirror posted <ttid> [S<s>E<e>]
  (HTTP <status>)`. The mirror token lifecycle copies
  `reconcile.mjs` `syncTarget` for the mirror target: proactive
  refresh when the token is inside its last day, one
  refresh-and-retry on a 401, refreshed tokens persisted through
  `updatePairAuth(pair, 'mirrorSimkl', ...)`. Failures log
  `[live] mirror failed <item> — <reason>` (no secrets) and the
  reconciler backfills on its next run.
- Semantics change, stated plainly: instant mirroring marks at pick
  time — started counts as marked, the same rule as the picker's own
  live marking. The reconciler path still only marks
  flagged-watched items. Nothing about pair storage, the configure
  page, the reconciler, or the primary live write changed, and no
  new environment variables were added; `DEBUG_LOG=0` silences the
  new lines with all the others (they go through `debug-log.mjs`,
  scope `live`).

**Files Changed**

- `src/reconciler/live-mirror.mjs` (new): pair matching
  (`findPairForClientId`), the single-item baseline check
  (`itemInBaseline`), the pure decision function
  (`decideLiveMirror`), the payload builder (`buildMirrorPayload`),
  and the fail-silent async entry (`mirrorLivePick`) with the
  refresh-and-retry token handling and all `[live]` mirror log
  lines. The network/store functions are injectable seams for tests;
  production defaults are the real pair store and Simkl helpers.
- `src/utils/receivers/simkl/api/sync.ts`: after a confirmed live
  Simkl write, fire-and-forget `mirrorLivePick` with the config's own
  Simkl client_id and the picked item (IMDb id, plus season/episode
  for series). Picks without an IMDb id skip it — the baseline scheme
  is IMDb-based, as in the reconciler.
- `tests/live-mirror.test.mjs` (new) and `package.json`
  (`test:live-mirror` script): 11 tests — baseline membership for
  movies and episodes, the decision matrix (baseline hit/miss, Watch
  Together off via Ange's pair, no mirror account, missing/invalid
  baseline, no pair match), payload shape, exclusion/posted log
  lines, silence for non-Watch-Together and unmatched picks,
  401 refresh-and-retry with persistence, 401 with no refresh token,
  an end-to-end run through the real encrypted pair store and the
  real `postHistory` (mocked fetch) proving the wire request carries
  the mirror credentials, and `DEBUG_LOG=0` silencing.
- `SETUP.md`: new "Watch Together — Instant Mirror" section after
  Step 7, plus a line in the Debug Log section.
- `BUILD_REPORT.md`: this section.

**Gate Results (This VM)**

- `npm run test:reconciler`: 12/12 pass — unchanged from the logger
  build's baseline.
- `npm run test:live-mirror`: 11/11 pass (new suite).
- `npm run build`: 0 errors (type check and lint checked; the 19
  warnings are pre-existing and none are in the changed files).
- Smoke: the built server was run with a fixture `DATA_DIR`
  (synthetic encrypted pairs: a Watch Together pair whose baseline
  holds Simpsons S37E10/S37E11, mirror creds as obvious `smoke-*`
  placeholders, and a plain Ange pair). `/configure` returned HTTP
  200. A harness then drove the real mirror code path against that
  fixture data dir with `fetch` stubbed to a local mock Simkl
  (HTTP 201): the in-baseline pick (S37E11) logged
  `mirror excluded (in baseline)` and posted nothing; the
  post-baseline pick (S37E12) posted exactly once, with the mirror
  account's credentials and the single-episode payload, and logged
  `mirror posted tt0096697 S37E12 (HTTP 201)`; picks carrying Ange's
  client_id and an unknown client_id produced no posts and no log
  lines. The harness drove the mirror helper directly rather than a
  full stream pick through the Qwik route — generating a real addon
  config URL for the fixture was not practical in this VM; the
  route-side trigger is covered by the build, the unit tests, and
  the wire test above. Smoke processes and fixtures were removed
  afterwards.
- Not verified here: the instant mirror against real Simkl accounts
  and real tokens, inside Stremio Kai on TK's PC, and the token
  refresh path against the live Simkl token endpoint (covered by
  injected-fake tests only). Applying this build needs only
  `docker compose up -d --build` — no pair re-save, no re-setup.

## Confirmed Simkl Counts In The Debug Log (Added 2026-11-03)

Follow-up to the instant-mirror live session: when the South Park
S29E4 test mirrored to Ange's Simkl, her show page showed Simkl's
"watched all" wording and the log could not settle whether one
episode or the whole show had been marked — it only recorded the
HTTP 201. (Only the tested episode was actually ticked on her
account — the "watched all" was Simkl's show-page label.) Simkl's
`/sync/history` response has
always reported the truth in its `added` object — the actual count
of movies, shows, and episodes it marked — but `postHistory` threw
that body away. This build threads the confirmed counts into the
debug log everywhere a write is recorded.

**Design**

- `src/reconciler/simkl.mjs`: `postHistoryChunk` already returned
  the parsed response body; `postHistory` now parses each chunk's
  `added` object with the new `parseAddedCounts` and passes it to
  the `onPost` callback as `info.added`, alongside the existing
  sent counts and HTTP status. Parsing is defensive: a missing
  `added`, or a field that is not a finite, non-negative number,
  degrades to null (per field, or overall) and never throws. The
  new `formatAddedCounts` renders the one-line suffix —
  `Simkl added 1 episode(s)`, `Simkl added 2 movie(s), 3
  episode(s)` — from the movie and episode counts (the show-entry
  count is parsed but not rendered; movies and episodes are the
  units that reconcile against what was sent). A confirmed zero is
  rendered when Simkl reports counts but added nothing, so a
  re-post of an already-watched item reads as confirmed-zero
  rather than silence. No `added` in the response → no suffix, and
  the log line keeps its previous form exactly.
- `src/reconciler/reconcile.mjs`: the `attemptSync` post callback
  appends the suffix to the per-chunk line —
  `POST /sync/history — 0 movie(s), 1 show(s) → HTTP 201 — Simkl
  added 2 episode(s)`. `attemptSync` serves both the pair sync
  (scope `pair:<name>`) and the Watch Together mirror sync (scope
  `mirror:<name>`), so both trails gained the counts with one
  change.
- `src/reconciler/live-mirror.mjs`: the instant mirror captures
  `info.added` in its `onPost` and the posted line becomes
  `[live] mirror posted tt0121955 S29E4 (HTTP 201) — Simkl added
  1 episode(s)`.
- `src/utils/receivers/simkl/api/sync.ts`: the picker's own live
  write line gained the same suffix. The axios response body was
  already in hand at that point (it is the function's return
  value), so this was a minimal change — parse `response.data`
  with the same two helpers — and no stock receiver code was
  restructured.
- Secrecy unchanged: only the three numeric counts are read from
  the response. Raw response bodies are never logged, and no
  tokens, keys, or config material are involved.

**Files Changed**

- `src/reconciler/simkl.mjs`: `parseAddedCounts` and
  `formatAddedCounts` (new, exported); `postHistory` passes
  per-chunk `added` through `onPost`.
- `src/reconciler/reconcile.mjs`: confirmed-count suffix on the
  `attemptSync` post line (pair and mirror scopes).
- `src/reconciler/live-mirror.mjs`: confirmed-count suffix on the
  `[live] mirror posted` line.
- `src/utils/receivers/simkl/api/sync.ts`: confirmed-count suffix
  on the `stream pick — Simkl write posted` line.
- `tests/reconciler.test.mjs`: 4 new tests (suite now 16) —
  defensive parse/render cases; `postHistory` per-chunk threading
  including a no-`added` response surfacing `added: null`; a full
  `reconcilePair` run whose pair and mirror post lines carry the
  confirmed counts; a run against bare `{}` history responses
  whose lines stay byte-identical to before. The fetch installer
  gained an opt-in `historyAdded` hook; default behavior is
  unchanged.
- `tests/live-mirror.test.mjs`: 3 new tests (suite now 14) — the
  posted line with confirmed counts, the posted line unchanged
  when no counts are reported, and an end-to-end run through the
  real pair store and real `postHistory` (mocked fetch) whose log
  line carries `Simkl added 1 movie(s)`.
- `SETUP.md`: Debug Log section explains sent vs. confirmed
  counts.
- `BUILD_REPORT.md`: this section.

**Gate Results (This VM)**

- `npm run test:reconciler`: 16/16 pass (the previous 12
  unchanged, plus the 4 above).
- `npm run test:live-mirror`: 14/14 pass (the previous 11
  unchanged, plus the 3 above).
- `npm run build`: 0 errors (type check and lint checked; the 19
  warnings are pre-existing and none are in the changed files).
- Smoke: the real standalone reconciler entry
  (`scripts/reconciler.mjs`) was run against a fixture `DATA_DIR`
  (one synthetic encrypted Watch Together pair, baseline holding
  S1E1 of the test show) with `fetch` stubbed at the process
  boundary via a `--import` preload: Stremio served one watched
  movie and the series up to S1E2; Simkl libraries were empty;
  `/sync/history` answered 201 with `added` counts. The run's
  debug log shows all four post lines carrying the confirmation —
  `[pair:TK] … — Simkl added 1 movie(s)`, `[pair:TK] … — Simkl
  added 2 episode(s)`, `[mirror:TK] … — Simkl added 1 movie(s)`,
  `[mirror:TK] … — Simkl added 1 episode(s)` (the mirror's single
  episode is the baseline doing its job) — and `status.json`
  recorded a clean run (added 1 movie / 2 episodes, mirror added
  1 / 1, no error). The built web server, run with the same
  fixture data dir, answered `/configure` with HTTP 200. The
  `[live]` lines were driven at the module level by the
  end-to-end test (real pair store, real `postHistory`, mocked
  fetch), not through a full stream pick in the running server —
  generating a real addon config URL for the fixture remains
  impractical in this VM, as noted in previous sections. Smoke
  processes and fixtures were removed afterwards.
- Not verified here: the confirmed counts against the real Simkl
  API (its live `added` response shape is taken from the API
  docs and the parser degrades to the old log lines if the fields
  are absent), and the new lines inside Stremio Kai on TK's PC.
  Applying this build needs only `docker compose up -d --build` —
  no pair re-save, no re-setup.

## Solo / Together Switch — WATCH_TOGETHER .env Override (Added 2026-11-03)

TK's request: switching Watch Together on the configure page meant
re-entering Ange's Client Id and redoing her mirror approval every
time, because the page holds nothing between visits and a
Watch Together-off save discarded the stored mirror sign-in. He
asked for the switch to be a file edit instead. This build makes it
one line in `.env`, plus a restart.

**Design**

- **One shared effective-mode gate.** `effectiveWatchTogether(pair,
  env)` in `src/reconciler/watch-together-baseline.mjs` returns the
  `WATCH_TOGETHER` override when set, else the pair's stored flag.
  `parseWatchTogetherOverride` accepts `on`/`off` and
  `true`/`false`, case-insensitive with surrounding whitespace
  ignored; unset, empty, or unrecognized values are *no override*,
  never a guess. Both mirroring paths — the reconciler's mirror
  pass and the instant mirror (`decideLiveMirror` /
  `mirrorLivePick`, which gained an optional `env` parameter) —
  consult this one helper, so the switch can never be half-applied.
- **Parked mirror sign-in.** The pair-save route
  (`src/routes/api/pairs/index.ts`) now resolves the stored mirror
  credentials through `resolveMirrorForSave(supplied, existingPair)`
  in `pairs-store.mjs`: freshly supplied credentials (a completed
  mirror approval) win; when a save supplies none, the credentials
  already stored on the pair are kept. A Watch Together-off save
  therefore parks the sign-in instead of deleting it. The save-time
  baseline rules are otherwise unchanged (turning on captures,
  re-saving while on keeps, turning off drops). The
  Watch Together-on validation also accepts the parked credentials,
  so re-enabling from the page no longer demands a fresh approval
  either. First-ever enable still needs the one-time approval,
  because there is nothing parked yet.
- **Applied-mode tracking.** The pair record gains an optional
  field, `watchTogetherAppliedMode: 'on' | 'off'` — the effective
  mode the reconciler last applied. It is stored **on the pair
  record** (via the new `updatePairWatchTogether` in
  `pairs-store.mjs`, which reloads the store and mutates only the
  Watch Together fields, so a token refreshed moments earlier is
  never clobbered by a stale in-memory pair) rather than in
  `status.json`: the mode is a property of the pair's stored
  state, must survive status rewrites, and travels with the
  baseline it describes. A configure-page save rebuilds the record
  without the field, resetting it to unset for the reconciler to
  re-derive (adopt / recapture / set off) — deliberately *not*
  preserved across page saves, so a baseline captured by the page
  flow is adopted exactly, never recaptured seconds later.
- **Transition rules** (reconciler, per pair, per run). The whole
  state machine is gated on the pair carrying some trace of the
  feature (`wtTracked`: a mirror sign-in, the stored flag, a valid
  baseline, or a recorded applied mode):
  - Effective on + applied on + valid baseline → mirror as usual.
  - Effective on + applied unset + valid baseline → **adopt** the
    stored baseline (record applied=on, silently — adoption adds
    no log lines). This is TK's live pair on deploy day.
  - Effective on + applied off, or no valid baseline → **capture a
    fresh baseline** now (`captureWatchTogetherBaseline` against
    the pair's Stremio account), store it, record applied=on, log
    `[mirror:<name>] Watch Together switched on — starting point
    captured (N movie(s), M episode(s))`, and mirror nothing beyond
    it this run (the pass runs against the fresh baseline, so the
    diff is empty). If the capture fails: log the failure, flag
    `needsBaseline`, mirror nothing, and leave the applied mode
    untouched so the next run retries — fail closed. Readiness is
    revoked *before* the capture attempt, so a failed capture can
    never fall through to mirroring against the stale pre-switch
    baseline (a bug the new tests caught during this build).
  - Effective off → no mirror pass, no live mirror; record
    applied=off (once, not per run). When the off state comes from
    the .env override and the pair has a mirror configured, each
    run logs one line: `[mirror:<name>] Watch Together off —
    mirror skipped (solo)`.
  - Pairs with no Watch Together trace at all (Ange's) skip every
    branch in every switch state: no store writes, no mirror log
    lines, no `needsBaseline` — the override never invents Watch
    Together for a pair that was never set up for it. (The first
    smoke run caught the env=on case leaking into Ange's pair;
    the state machine is now gated, with a regression test.)
- **Live mirror guard.** Beyond the effective-mode gate,
  `decideLiveMirror` skips silently when the pair's applied mode
  is `'off'`: after a switch-on, until the reconciler's first run
  captures the fresh starting point, the stored baseline is still
  the pre-solo one and a live pick against it could copy a solo
  watch across. The reconciler remains the mechanism of record
  and covers the pick once the switch is applied.
- **Run summaries** in `reconcile.mjs` now key the mirror suffix
  on whether the mirror pass actually ran (`mirrorRan`) instead of
  the stored flag, so env-driven runs report their mirror counts.
- **Behavior change to note:** a Watch Together pair *with mirror
  credentials* but no valid baseline no longer sits at
  `needsBaseline` until a page re-save — the reconciler captures a
  starting point at runtime (transition rule above). The
  no-credentials case keeps the old report verbatim, and capture
  failure still flags `needsBaseline`. One pre-existing test was
  updated to the new semantics (see Gates). With the env var unset
  and a pair in steady state, run behavior and log lines are
  unchanged from the previous build.
- **Env plumbing.** `docker-compose.yml` enumerates its
  `environment:` block explicitly (there is no `env_file`), so
  `WATCH_TOGETHER: ${WATCH_TOGETHER:-}` was added there — unset in
  `.env` passes an empty string, which the parser treats as no
  override. Both container processes inherit it: the reconciler
  (`scripts/reconciler.mjs`) and the web server (the instant
  mirror reads the same `process.env`). `.env.example` documents
  the line. No Dockerfile change was needed.

**Files Changed**

- `src/reconciler/watch-together-baseline.mjs`:
  `parseWatchTogetherOverride`, `watchTogetherOverride`,
  `effectiveWatchTogether` (new).
- `src/reconciler/pairs-store.mjs`: `updatePairWatchTogether` and
  `resolveMirrorForSave` (new); pair-shape comment documents
  `watchTogetherAppliedMode`.
- `src/reconciler/reconcile.mjs`: the mirror section is now the
  applied-mode state machine described above; `reconcilePair` and
  `runReconcilerOnce` accept an optional `env`; run summaries key
  on `mirrorRan`.
- `src/reconciler/live-mirror.mjs`: effective-mode gate +
  applied-mode `switch-pending` guard in `decideLiveMirror`;
  `mirrorLivePick` takes an optional `env`.
- `src/reconciler/types.ts`: `watchTogetherAppliedMode?: 'on' |
  'off'` on `SimklStremioPair`.
- `src/routes/api/pairs/index.ts`: parked mirror sign-in via
  `resolveMirrorForSave`; the existing pair is loaded before the
  Watch Together validation so parked credentials satisfy it.
- `docker-compose.yml`: `WATCH_TOGETHER` added to the
  `environment:` block. `.env.example`: the line documented.
- `tests/reconciler.test.mjs`: 10 new tests (suite now 26) + 1
  updated (below).
- `tests/live-mirror.test.mjs`: 3 new tests (suite now 17).
- `SETUP.md`: Step 7 notes the parked sign-in; new section
  "Watch Together — The Solo / Together Switch (.env)".
- `BUILD_REPORT.md`: this section.

**Gate Results (This VM)**

- Pre-change baseline, verified before editing:
  `npm run test:reconciler` 16/16, `npm run test:live-mirror`
  14/14.
- `npm run test:reconciler`: **26/26 pass.** New: override
  parsing and the effective-mode matrix; `updatePairWatchTogether`
  field isolation; `resolveMirrorForSave` fresh-wins / parked /
  partial / none cases; switch-on capture happening **exactly
  once** across two consecutive runs (a solo-period watch stays
  unmirrored, a post-capture watch mirrors, `capturedAt`
  unchanged); no recapture on a simulated restart with applied=on;
  adoption of an existing valid baseline when the applied mode is
  unset; `WATCH_TOGETHER=off` suppressing the reconciler mirror
  with the pair flag on (solo line exactly once, TK's own sync
  unaffected, Ange's stored record byte-identical, zero
  `[mirror:Ange]` lines); `WATCH_TOGETHER=on` mirroring through a
  parked sign-in with the pair flag off; capture failure leaving
  the applied mode off and the old baseline on disk, nothing
  mirrored, mirror library never fetched; and the regression test
  that env=on never invents Watch Together for a setup-less pair.
  **One pre-existing test updated:** "Watch Together without a
  baseline mirrors nothing and flags needsBaseline" became
  "…captures a starting point and mirrors nothing beyond it" —
  the transition rules replace the sit-at-needsBaseline behavior
  for pairs that have mirror credentials (see Design); the
  failure path and the no-credentials path keep their
  needsBaseline coverage.
- `npm run test:live-mirror`: **17/17 pass** (the previous 14
  unchanged). New: env=off silencing the live mirror with the
  pair flag on (plus a garbage value falling back to the flag);
  env=on firing through a parked sign-in with the pair flag off;
  the `switch-pending` guard skipping picks while the applied
  mode is still off.
- `npm run build`: **0 errors** (type check and lint checked; 18
  warnings, all pre-existing — the one in
  `src/routes/api/pairs/index.ts` is the pre-existing
  `body.simkl?.` optional-chain warning on a line this build did
  not change).
- Smoke: the **real reconciler entry** (`node scripts/reconciler.mjs`,
  one fresh process per phase) ran against a fixture `DATA_DIR`
  (TK pair in deploy-day state — flag on, stored baseline, *no*
  applied-mode field; Ange pair plain) with `fetch` stubbed at the
  process boundary via a `--import` preload and a mutable
  scenario file, across the sequence **unset → off → on → on →
  restart**: **25/25 checks passed.** Unset adopted the stored
  baseline (post-baseline movie + episode mirrored, no capture,
  applied recorded on); off logged the solo line exactly once,
  posted nothing to the mirror, recorded applied=off, and left
  the baseline untouched; on captured exactly one fresh starting
  point — `(3 movie(s), 2 episode(s))`, including the watch made
  during solo — and mirrored nothing that run; the second on run
  mirrored a new watch against that baseline with no recapture;
  the restart run changed nothing (still one capture line total,
  nothing left to post). Ange's pair produced no mirror lines in
  any phase and its stored record was verified untouched at the
  end. The first smoke attempt (22/23) caught the env=on leak
  into Ange's pair described in Design; the gate + regression
  test followed, and the re-run is the 25/25 above. Smoke
  fixtures and processes were removed afterwards.
- Not verified here: the switch against real Stremio/Simkl
  accounts and in Stremio Kai on TK's PC (the live-mirror env
  gate is covered at module level by the unit tests and the
  reconciler end-to-end by the smoke run; a full stream pick
  through the running web server remains impractical in this VM
  for the config-URL reason noted in earlier sections), and the
  configure page's parked-credentials save in a real browser (the
  merge rule is unit-tested via `resolveMirrorForSave`; the route
  change is type-checked by the build). Applying this build
  needs `docker compose up -d --build` — no pair re-save: TK's
  stored baseline is adopted on the first run, and his mirror
  sign-in is already stored.

## Three Upgrades — Marking Modes, Undo, Tailscale HTTPS (Added 2026-11-04)

TK asked what was left to improve and took all three: (1) options
for *when* a pick marks, (2) an undo for a wrong mark, and (3) a
way for Ange's Stremio to install the addon at all. One build, three
commits' worth of surface, gated as usual.

**Upgrade 1 — Marking-mode switches (LIVE_MARK / MIRROR_LIVE_MARK)**

- **Shared parser.** `src/reconciler/marking-modes.mjs`:
  `parseMarkingMode` accepts `all` / `movies` / `off`
  (case-insensitive, whitespace ignored); unset, empty, or anything
  else is *no override* — never a guess, the same rule as
  `parseWatchTogetherOverride`. `decideLiveMark(env, item)` is the
  pure own-account decision; `mirrorLiveMarkMode(env)` feeds the
  mirror's decision. Both vars ride the existing compose
  `environment:` plumbing (`${LIVE_MARK:-}`, `${MIRROR_LIVE_MARK:-}`)
  and are documented in `.env.example`.
- **Own write gate** (`src/utils/receivers/simkl/api/sync.ts`): the
  narrowest correct point is `syncSimklMetaObject` itself — it
  already knows whether the pick is a movie or an episode
  (`ids.count`). When `LIVE_MARK` forbids the pick type, the
  function logs one line and returns before any Simkl call:
  `[live] live mark skipped for tt0096697 S37E12 — LIVE_MARK=movies`.
  Returning early is safe: the one caller awaits the function and
  ignores its result. With the var unset the code path is
  byte-for-byte the old behavior and no line is written.
- **Instant mirror gate** (`live-mirror.mjs`): `decideLiveMirror`
  gained a fifth outcome, `{ action: 'skipped-mode', mode }`,
  checked once the mirror machinery is known to apply (pair matched,
  effective Watch Together on, not switch-pending, mirror account
  present) and *before* the baseline check — so a set mode explains
  every forbidden pick with one line
  (`[live] mirror skipped for … — MIRROR_LIVE_MARK=off`), while
  picks the mode allows fall through to the baseline decision
  exactly as before. `mirrorLivePick` logs the line; the fire in
  `sync.ts` was restructured into a local `fireMirror()` that runs
  regardless of the own-write gate, because the two modes are
  independent: `LIVE_MARK=off` + `MIRROR_LIVE_MARK=all` means
  reconciler-only for TK's own account while together picks still
  mirror instantly. The reconciler (own and mirror passes) is
  untouched by either var.

**Upgrade 2 — Undo: POST /api/remove-history**

- **Simkl surface** (`simkl.mjs`): `removeFromHistory(auth, payload)`
  posts the same single-item payload shape as `/sync/history` to
  `/sync/history/remove` (verified against Simkl's API reference:
  same body shape; the response reports a `deleted` object).
  `parseRemovedCounts` / `formatRemovedCounts` mirror the
  added-counts pair field-for-field — `deleted` first, `removed`
  accepted as a fallback key, missing/non-numeric → null, a known
  zero rendered as confirmed-zero ("Simkl removed 0 movie(s),
  0 episode(s)").
- **Core** (`src/reconciler/remove-history.mjs`):
  `validateRemoveRequest` (pair name required; target `own` |
  `mirror`; IMDb id must match `/^tt\d+$/`; season and episode both
  or neither; whole numbers, season ≥ 0, episode ≥ 1) and
  `removeHistoryItem`, which loads the pair (unknown pair → 400;
  mirror target with no mirror credentials → 400), picks the
  target's credentials, and writes with the house token lifecycle —
  proactive refresh inside the last day, one refresh-and-retry on
  401, persistence through `updatePairAuth` under the target's own
  key. Simkl-side failures surface as 502 with the reconnect wording
  the other writers use. Success logs under scope `remove`:
  `[remove] removed tt0121955 S29E4 from mirror of pair TK
  (HTTP 201) — Simkl removed 1 episode(s)`.
- **Mirror-removal semantics.** After a successful mirror removal,
  the core reloads the pair and appends the item to its Watch
  Together baseline (`addToWatchTogetherBaseline` in
  watch-together-baseline.mjs — pure, deduped, sorted, same
  movie-id / "season:episode" scheme) persisted through
  `updatePairWatchTogether`, so no later reconcile or instant
  decision can copy it again. With no valid baseline the removal
  still stands and the response carries `baselineNote:
  'no-baseline'` plus a note saying so. Own removals never touch
  the baseline, and the own note states the reconciler consequence
  (still flagged in Stremio → re-added next run).
- **Route + page.** `src/routes/api/remove-history/index.ts`
  follows the pairs route's conventions (same `getSecret`, no login
  — LAN only, same standing warning). The configure page gains a
  **Remove From Simkl History** section
  (`remove-history-section.tsx`, rendered after Save Pair): pair
  picker from the existing GET /api/pairs list, target picker with
  the mirror option offered only when the selected pair has one,
  IMDb Id / Season / Episode fields, and a result line whose
  wording comes from the server's `note` so the two semantics read
  identically wherever the result is seen. One copy fix rode along:
  the Save Pair section no longer claims "nothing is ever removed
  from Simkl" — it now says the reconciler never removes anything.
  SETUP.md's add-only statements were amended the same way.

**Upgrade 3 — Ange's addon over Tailscale Serve (docs + one compose line)**

Investigation findings, from the code:

- **Origin.** The Qwik City Node adapter resolves the request
  origin as `getOrigin ?? opts.origin ?? process.env.ORIGIN ??
  fallback`, and the container's start script feeds it from
  `APP_ORIGIN` (`start:local`). The one thing that made the
  documented flow impossible: `docker-compose.yml` **hardcoded**
  `APP_ORIGIN: http://localhost:${HOST_PORT:-8181}`, so setting
  `APP_ORIGIN` in `.env` changed nothing. That line is now
  `APP_ORIGIN: ${APP_ORIGIN:-http://localhost:${HOST_PORT:-8181}}`
  — the only code change this upgrade needed. Default behavior is
  unchanged.
- **Install link.** Built client-side in `configure.tsx` from
  `location.url.host` — it follows whatever address the browser
  used, so a configure page opened at the ts.net address produces
  ts.net links with no code change.
- **Nothing else assumes HTTP.** The Simkl sign-in is the device
  flow (no redirect URI anywhere); connections live in browser
  localStorage, not cookies, so there is no cookie/secure-flag
  behavior behind the proxy; no server code builds absolute URLs
  from the Host header.
- SETUP.md gained the section "Ange's Addon Over Tailscale
  (HTTPS)": same-tailnet installs, MagicDNS + HTTPS certificates,
  `tailscale serve --bg 8181` on the PC, `APP_ORIGIN` set to the
  ts.net origin in `.env`, her install produced from the ts.net
  configure page, Tailscale-running caveat for instant marks, and
  in bold: **Serve only, never Funnel; never port-forward 8181** —
  the pairs API has no login and install links are bearer secrets.
- **Not testable from this VM:** there is no Tailscale here. This
  part is verified by code reading and the production build only;
  TK's PC + Ange's laptop are the gate, exactly as SETUP.md lays
  out.

**Files changed**

- New: `src/reconciler/marking-modes.mjs`,
  `src/reconciler/remove-history.mjs`,
  `src/routes/api/remove-history/index.ts`,
  `src/components/sections/remove-history/remove-history-section.tsx`,
  `tests/remove-history.test.mjs`.
- Edited: `src/reconciler/simkl.mjs` (remove call + removed-counts
  pair), `src/reconciler/watch-together-baseline.mjs`
  (`addToWatchTogetherBaseline`), `src/reconciler/live-mirror.mjs`
  (mode gate), `src/utils/receivers/simkl/api/sync.ts` (LIVE_MARK
  gate + shared `fireMirror()`), `src/components/sections/configure.tsx`
  (render the new section), `src/components/sections/save-pair/save-pair-section.tsx`
  (copy fix), `docker-compose.yml` (APP_ORIGIN from .env; LIVE_MARK /
  MIRROR_LIVE_MARK passthrough), `.env.example`, `package.json`
  (`test:remove-history` script), `tests/live-mirror.test.mjs`,
  `SETUP.md`, `docs/SIMKL_AUTH.md`, this report.

**Gate results (this VM)**

- Pre-change baselines re-verified before any edit: reconciler
  26/26, live-mirror 17/17 — and both suites were re-run green
  after the feature code landed, before the new tests were added.
- Reconciler tests: **26/26** (unchanged — neither marking var
  touches the reconciler).
- Live-mirror tests: **21/21** (17 previous, untouched + 4 new:
  parsing matrix, `decideLiveMark` matrix, `decideLiveMirror`
  mode matrix incl. baseline interplay and Ange-silence, and
  `mirrorLivePick` skip lines with zero posts).
- Remove-history tests: **11/11** (new suite): validation matrix
  (12 bad bodies → 400), removed-counts parsing/formatting,
  baseline-append purity, own movie removal (own creds, payload
  shape, baseline untouched, log line), mirror episode removal
  (mirror creds, payload shape, item in the stored baseline,
  tokens intact, both log lines), mirror movie removal, no-baseline
  mirror removal reported skipped, unknown/mirror-less pair 400s
  before any Simkl call, 401 refresh-and-retry with persistence,
  401-without-refresh-token 502 with the baseline unchanged, and
  proactive refresh persisted before an own removal.
- `npm run build`: **0 errors** (type + lint checked; 19 warnings,
  all pre-existing — the one new lint error the first build caught,
  a non-serializable helper closure in the new section's change
  handler, was fixed by inlining it).
- Smoke: the **built server** (`server/entry.express.js`) ran
  against a fixture `DATA_DIR` (synthetic encrypted pairs: TK with
  mirror + baseline, Ange without) with `fetch` stubbed at the
  process boundary via a `--import` preload. Over real HTTP:
  `GET /` (configure) → 200; `GET /api/pairs` → 200 with both
  pairs; invalid IMDb → 400; mirror removal on Ange's pair → 400
  (no mirror connected); TK mirror episode removal → 200 with
  `baselineUpdated: true`. The stub captured exactly one Simkl
  call — `POST /sync/history/remove` carrying the **mirror**
  client's key and the single-episode payload — and afterwards the
  stored pair's baseline held `1:3` alongside `1:1`, `1:2`, the
  mirror token was intact, and `debug.log` carried both `[remove]`
  lines with Simkl's confirmed count. Server killed, fixtures
  removed.

**Not verified**

- The Tailscale Serve path end to end (no Tailscale in this VM) —
  docs + compose support only, per the design notes above.
- The marking modes and the undo against real Simkl accounts and
  in Stremio Kai on TK's PC; the remove endpoint's response shape
  is from Simkl's published API reference, and the parser degrades
  to no-count log lines if it ever differs.
- `sync.ts` itself is not unit-testable in the node harness (it is
  Qwik/TypeScript app code, like the rest of the receivers); its
  gate decision is the tested `decideLiveMark`, and the wiring is
  covered by the production build's type check.
- Applying needs `docker compose up -d --build` — no pair re-save,
  no data migration.
