# Simkl Auth — OAuth 2.0 (AUTH V2) Device Flow

Findings from Simkl's official API documentation, verified 2026-11-01.
Canonical docs: https://api.simkl.org (flattened text: https://api.simkl.org/llms-full.txt).
API host: `https://api.simkl.com`. Consent host: `https://simkl.com`.

## Why This Document Exists

Stock syncribullet signs in to Simkl with the legacy AUTH V1 PIN flow
(`GET https://api.simkl.com/oauth/pin`). Simkl's developer portal now issues
AUTH V2 (OAuth 2.0) apps, and a V2 `client_id` is refused by the V1 endpoints:

```json
{"error":"unauthorized_client","code":400,"message":"This client_id is an OAuth 2.0 app: use POST /oauth2/device instead of /oauth/pin"}
```

(Observed live during the SimklStremio stock test, 2026-11-01.)

Per the docs, V1 and V2 registrations are sealed off from each other in both
directions: V1 credentials sent to `/oauth2/*` return `401 invalid_client`,
and a V2 `client_id` sent to V1 endpoints returns `400 unauthorized_client`.
Each registration works only with its own endpoints.
Source: "Device / PIN flow (AUTH V2)" and "PIN flow (AUTH V1)" pages,
https://api.simkl.org/api-reference/oauth2-device and /api-reference/pin.

V1 is being retired — the docs say V1 apps are expected to stop working
around April 2027 — so this build uses AUTH V2 throughout.

## The Device Flow (RFC 8628)

Source: https://api.simkl.org/api-reference/oauth2-device

Any V2 client type can use this flow (it is not limited to apps registered as
"TV, devices & command line"). No `client_secret` and no redirect URI are
involved, which is why no redirect registration is needed for this flow —
the exact-match redirect rule only applies to flows that carry a redirect.

### Step 1 — Start The Authorization

```
POST https://api.simkl.com/oauth2/device
Content-Type: application/x-www-form-urlencoded
User-Agent: <app-name>/<app-version>

client_id=YOUR_CLIENT_ID
scope=media:read media:write
```

- `client_id` is the only credential needed to start the flow.
- `scope` is optional; omitting it yields `media:read` only. Anything that
  writes (marking watched, scrobbling) needs `media:write`, so this build
  always requests `media:read media:write`. An unrecognised scope string is
  silently downgraded to read-only, so the granted scope in the token
  response must be checked before relying on writes.

Response:

```json
{
  "device_code": "...",
  "user_code": "BDWP-HQPK",
  "verification_uri": "https://simkl.com/pin",
  "verification_uri_complete": "https://simkl.com/pin?user_code=BDWP-HQPK",
  "expires_in": 900,
  "interval": 5
}
```

- `user_code`: 8 characters, shown as `XXXX-YYYY`. Show it exactly as
  returned, hyphen included.
- `verification_uri_complete` is the preferred link to give the user: the
  code is pre-filled and they only have to click Allow. It grants nothing on
  its own. `device_code` is the polling credential — never display or log it.

### Step 2 — The User Approves

The user opens `verification_uri_complete` (or goes to
`https://simkl.com/pin` and types the `user_code`), signs in to Simkl, and
clicks Allow. There is no deny signal: declining produces the same
`authorization_pending` polling response as walking away, so the client must
run its own timeout bounded by `expires_in` (900 seconds).

### Step 3 — Poll For The Token

```
POST https://api.simkl.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id=YOUR_CLIENT_ID
device_code=YOUR_DEVICE_CODE
```

Poll every `interval` seconds (5 by default), never faster.

| Status | `error` | Meaning / Action |
| ------ | ------- | ---------------- |
| 400 | `authorization_pending` | Not approved yet. Keep polling at the same interval. |
| 400 | `slow_down` | Polled too fast. Add 5 seconds to the interval and wait — the timer is reset by the attempt itself, so immediate retries stay locked out. |
| 400 | `expired_token` | The device code is dead. Start over with a fresh code. |
| 401 | `invalid_client` | Unknown client ID, or an AUTH V1 app. Stop polling; fix the registration. |

Successful response (same shape for every V2 grant):

```json
{
  "access_token": "simkl_at_...",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "simkl_rt_...",
  "scope": "media:read media:write"
}
```

## Tokens And Refresh

Source: https://api.simkl.org/api-reference/oauth2-tokens

| Credential | Lifetime | Notes |
| ---------- | -------- | ----- |
| Access token | 7 days (`expires_in` 604800) | Sent as `Authorization: Bearer <token>`. |
| Refresh token | 180 days, sliding | Every refresh pushes the expiry out another 180 days. Non-rotating: the same refresh token string comes back in every refresh response. |
| Device code | 15 minutes | Poll every 5 seconds. |
| Authorization code | 10 minutes | Single-use (only relevant to the code + PKCE flow). |

Refresh call:

```
POST https://api.simkl.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
client_id=YOUR_CLIENT_ID
refresh_token=THE_STORED_REFRESH_TOKEN
```

(Registrations of type "Server apps & services" also send their
`client_secret`, as HTTP Basic or a `client_secret` parameter. Public client
types have no secret.)

Critical behaviour: refreshing **replaces** the access token on the grant —
the previous access token stops working immediately. One grant supports
exactly one live access token, so two processes that independently refresh
the same grant keep cutting each other off and both see intermittent 401s.
The supported patterns are: one owner process refreshes and shares the new
token, or each instance holds its own separate grant.

Handling a 401 on an API call, in order of likelihood: the token expired
(refresh, retry once); another process sharing the grant refreshed (do not
refresh — re-read the shared token); or the user revoked the app at
https://simkl.com/settings/connected-apps/ (refreshing fails too — a fresh
authorization is required).

## Using V2 Tokens On The Sync Endpoints

The `/sync/*` endpoints are not split by auth version; a V2 access token is
presented exactly like a V1 one:

- `Authorization: Bearer <access_token>` — required on all user-scoped
  endpoints. A V2 app calling without the user token gets
  `401 user_token_required`.
- The app is identified by `client_id`, sent either as the `simkl-api-key`
  header (what this codebase already does in
  `src/utils/receivers/simkl/api/headers.ts`) or as a `client_id` query
  parameter; the docs call the query-parameter form preferred but accept
  both. A missing or invalid `client_id` returns `412 client_id_failed`.
- Every request should carry a `User-Agent: <app-name>/<app-version>` header
  and the `client_id` / `app-name` / `app-version` parameters where the
  endpoint reference requires them.

Endpoints this build uses (all Bearer-authenticated):

- `POST /sync/history` — mark items watched (the sync paths are add-only;
  `/sync/add-to-list` is never called. `/sync/history/remove` is called
  only by the manual, per-item undo — see remove-history.mjs).
- `GET /sync/all-items/` — full library read. With `extended=full` and
  `include_all_episodes=original`, show entries include `seasons[]` with
  per-episode `{number, watched, last_watched_at}` rows, which is what the
  reconciler diffs against. (Docs note: episodes are skipped by default for
  `completed`/`dropped` items unless `include_all_episodes` is passed.)

## Fallback

The device flow works for V2 apps, so no fallback was needed. Had it not,
the alternative would have been the OAuth 2.0 authorization code flow with
mandatory PKCE (`S256`): browser consent at
`https://simkl.com/oauth2/authorize`, exchange at
`POST https://api.simkl.com/oauth2/token` with `grant_type=authorization_code`,
`code`, `code_verifier`, and a `redirect_uri` that must match a URL
registered in the app byte-for-byte (the `/oauth/simkl/` path on the app
origin is this codebase's existing return route).
Source: https://api.simkl.org/api-reference/oauth2-authorization-code
