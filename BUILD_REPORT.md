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
