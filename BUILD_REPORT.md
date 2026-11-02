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
