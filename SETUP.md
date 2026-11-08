# SimklStremio Setup

Self-hosted syncribullet fork. Tracks watched movies and TV episodes from
two Stremio accounts (TK, Ange) to two Simkl accounts. Add-only: the
sync itself never removes anything from Simkl — the one exception is a
manual, per-item undo on the configure page (see "Undo — Remove From
Simkl History" below). A server-side reconciler re-checks both
accounts on a schedule, so anything watched while the server was down is
backfilled on the next run — downtime delays tracking, it never loses it.

## What You Need

- Docker Desktop on the PC, running.
- This folder at `E:\Projects\SimklStremio`.
- One Simkl account each (TK, Ange) and one Stremio account each.

## Step 1 — Set The Encryption Key

1. Copy `.env.example` to `.env`.
2. Replace the `PRIVATE_ENCRYPTION_KEY` value with a fresh random key,
   letters and numbers only (32 or more characters).
3. Save the key somewhere permanent. If the key changes or is lost,
   saved pairs and generated install links stop working and everything
   has to be connected again. Do not reuse a key that was ever pasted
   into a chat.

## Step 2 — Start The Server

In this folder, from CMD or PowerShell:

```
docker compose up -d --build
```

First build takes a few minutes. Check it is up:

```
docker compose ps
docker compose logs -f
```

Stop / start later with:

```
docker compose down
docker compose up -d
```

## Step 3 — Addresses: Read This First

The configure page and the Simkl sign-in run in each person's own
browser, so the address matters:

- **TK, on the PC itself:** `http://localhost:8181`
- **Ange, on her laptop:** `http://<PC LAN IP>:8181` — for example
  `http://192.168.1.50:8181`. Find the PC's LAN IP with `ipconfig` on the
  PC. Windows Firewall may ask to allow Docker traffic on the private
  network; allow it.

Honest note: the install link Stremio uses is generated from the address
in the browser. The addon itself is loaded by Stremio from that address,
so install links made from the LAN address only work on the home
network — which is fine, the server only runs at home. The reconciler
does not depend on install links at all; pair syncing keeps working as
long as the container is running.

The Simkl device sign-in needs **no** redirect URL registered in the
Simkl app — the code/approve flow replaces the old redirect flow, so
there is nothing origin-sensitive in the Simkl setup.

## Step 4 — Create The Simkl Apps (One Per Person)

Each person creates their own app, signed in as themselves:

1. Go to https://simkl.com/settings/developer/new/
2. Name: anything (for example `SimklStremio TK`).
3. AUTH V2 is fine — this build signs in with the OAuth 2.0 device flow.
4. Save, and keep the app's page open — you need its **Client Id** in
   the next step.

TK creates one app under TK's Simkl account. Ange creates a separate
app under Ange's Simkl account. They are not interchangeable.

## Step 5 — Connect TK's Pair (On The PC)

1. Open `http://localhost:8181`.
2. Connect Stremio: open the Stremio section and sign in with the link
   flow (TK's Stremio account).
3. Connect Simkl: open the Simkl target, paste TK's app **Client Id**,
   click **Get Code**. A code appears. Click **Validate** — Simkl opens
   in a new tab. Approve the code there, signed in as TK. The configure
   page finishes the connection on its own (it polls; give it up to a
   minute).
4. Optional but recommended: run a manual **Import** from Stremio to
   Simkl once. It backfills the existing library right away; the
   reconciler would catch everything on its own schedule anyway.
5. Scroll to **Save Pair To Server**:
   - Pair Name: `TK`
   - Leave **Watch Together** off for now (Step 7).
   - Click **Save Pair**. The pair list under it should show `TK`.

## Step 6 — Connect Ange's Pair (On Her Laptop)

1. On her laptop, open `http://<PC LAN IP>:8181`.
2. Same flow as Step 5, with Ange's Stremio account and Ange's Simkl
   app Client Id.
3. In **Save Pair To Server**, Pair Name: `Ange`, Watch Together off.
   Click **Save Pair**. The pair list should now show both pairs.

## Step 7 — Watch Together (TK's Pair Only)

Watch Together mirrors what TK watches after it is switched on to
Ange's Simkl as well. It is a switch on TK's pair only, not always-on.

Switching it on starts from that moment: only things watched after
that are mirrored; nothing from before is copied.

1. On the PC, open `http://localhost:8181`.
2. In **Save Pair To Server**, set Pair Name to `TK` and tick
   **Watch Together**.
3. In the **Mirror Simkl Account** box, paste the Client Id of **Ange's**
   Simkl app, click **Get Code**, then **Validate** and approve on Simkl
   signed in as **Ange**.
4. Click **Save Pair** (this replaces TK's saved pair with the mirror
   attached). As part of that save, the server records TK's current
   watched movies and episodes as the starting point. If that starting
   point cannot be recorded, the save fails and Watch Together is not
   stored.
5. To turn it off later: untick Watch Together and Save Pair again.
   Turning it off drops the saved starting point, but it does **not**
   delete Ange's mirror sign-in — the sign-in stays parked on the
   server, so turning it back on here does not need her Client Id or
   a new approval. To start over from a new moment, save once with
   Watch Together off, then turn it on and save again; the second
   save records a new starting point.

Re-saving the pair while Watch Together stays on — for example to
reconnect a token — keeps the original starting point. It does not
move forward.

Day to day, though, you do not need this page to switch at all —
use the `.env` switch in the next section but one. This page is for
first-time setup and for reconnecting accounts.

## Watch Together — Instant Mirror

With Watch Together on, TK does not have to wait for the next
reconcile run for a watch to reach Ange's Simkl. When a stream is
picked through this fork's addon, the server posts the item to TK's
own Simkl (as before) and, in the same moment, to Ange's Simkl as
well. Look for these lines under `[live]` in `data\debug.log`:

- `mirror posted tt0096697 S37E12 (HTTP 201)` — the item landed on
  the mirror account at pick time.
- `mirror excluded (in baseline) tt0096697 S37E11` — the item is from
  before Watch Together was switched on, so nothing was copied.

The starting point is enforced exactly as in the reconcile runs:
re-picking anything watched before the switch-on mirrors nothing.

One honest difference from the reconciler path: instant means marked
at **pick** time. Starting an episode counts, even if it is stopped
a minute later — the same rule TK's own live marking already uses.
The reconciler remains the safety net: it still re-checks everything
on its schedule and backfills anything the instant path could not
see (picks through other addons, server downtime, a failed instant
post).

Ange's own watching is not affected. Her picks match her pair, which
has no Watch Together, so nothing she watches is ever mirrored
anywhere.

## Watch Together — The Solo / Together Switch (.env)

Once Watch Together is set up (Step 7), switching between watching
together and watching solo is one line in the `.env` file next to
`docker-compose.yml` — no configure page, no Client Id, no approval.

- **Solo:** set `WATCH_TOGETHER=off`
- **Together:** set `WATCH_TOGETHER=on`
- Then restart so the change takes effect:
  `docker compose up -d` (from `E:\Projects\SimklStremio`).

Leaving the line out of `.env` entirely means no override: the
Watch Together setting saved on the pair decides, exactly as
before this switch existed. The values are `on`/`off` (or
`true`/`false`), case-insensitive; anything else is ignored and
the saved setting decides.

**What solo means.** TK's watches stop copying to Ange — both the
instant mirror at pick time and the reconcile runs. Everything
else keeps working exactly as before: TK's own Simkl is still
synced, Ange's pair still syncs her own watching to her own Simkl.
Her mirror sign-in stays parked on the server the whole time;
nothing about her account is touched.

**Switching back on starts fresh.** When the mode changes from off
to on, the first reconcile run after the restart records TK's
current watched movies and episodes as a new starting point, and
only things watched after that are mirrored. Anything watched
while solo stays solo — it is inside the new starting point, so
it is never copied across later. In `data\debug.log` the switch-on
run shows one line like:

`[mirror:TK] Watch Together switched on — starting point captured (0 movie(s), 509 episode(s))`

While solo, each run logs
`[mirror:TK] Watch Together off — mirror skipped (solo)` so the
log proves the switch is in effect.

**A plain restart never moves the starting point.** Restarting
the container for any other reason — an update, a crash, the PC
rebooting — while the switch stays on mirrors against the same
starting point as before. Episodes watched together while the PC
was off still mirror when it comes back. Only an actual off → on
change of the switch (or of the saved pair setting) records a new
starting point.

One edge to know: switching on takes effect at the first
reconcile run after the restart, which happens within seconds of
the container starting. A pick made in the small gap before that
first run finishes is not instant-mirrored (the reconciler still
covers it once it is flagged watched) — this guard exists so a
solo watch can never slip across on a stale starting point.

## Marking Modes — When A Pick Marks (LIVE_MARK / MIRROR_LIVE_MARK)

A stream pick through the addon normally marks the item watched on
Simkl **at pick time** — started counts as watched. Two `.env` lines
narrow that, independently for your own account and for the instant
Watch Together mirror. Edit the line, restart
(`docker compose up -d`), done — the same pattern as the
solo/together switch.

- **`LIVE_MARK`** — your own Simkl's live write:
  - `all` (default): movies and episodes mark at pick time.
  - `movies`: movies mark at pick time; episodes do **not** — they
    reach your Simkl only via the reconciler, once Stremio flags
    them watched near the end of playback. No more false marks for
    episodes you only sampled.
  - `off`: no live writes at all. Your Simkl is kept in sync by the
    reconciler only.
- **`MIRROR_LIVE_MARK`** — the same three values, for the **instant
  mirror only**. `movies` or `off` here never touches the
  reconciler's mirror pass, which stays watched-flag-based exactly
  as before. It only matters while Watch Together is effectively on.

Leaving a line out — or giving it any other value — is the default
(`all`) and changes nothing: no behavior change, no new log lines.
When a mode does skip a pick, the debug log shows one line per pick,
for example:

- `[live] live mark skipped for tt0096697 S37E12 — LIVE_MARK=movies`
- `[live] mirror skipped for tt0096697 S37E12 — MIRROR_LIVE_MARK=off`

The two switches are independent: `LIVE_MARK=off` with
`MIRROR_LIVE_MARK=all` means your own account is reconciler-only
while together picks still mirror to Ange instantly.

## Undo — Remove From Simkl History

The configure page has a **Remove From Simkl History** section
(below Save Pair To Server) for the one-off wrong mark: an episode
that was only started, or a copy that landed on the mirror by
mistake. Pick the pair, pick the target, type the item's IMDb Id,
add Season and Episode for an episode (leave both blank for a
movie), and click **Remove**. One item at a time, by hand — there
is no batch form and nothing calls this automatically.

The two targets behave differently, on purpose:

- **Own Simkl** — removes the item from that pair's Simkl history.
  The Watch Together starting point is not touched. If the item is
  still flagged watched in Stremio, the reconciler will add it back
  on its next run — to make an own-account removal stick, unmark it
  in Stremio too.
- **Mirror (Watch Together)** — removes the item from the mirror
  account's Simkl history **and adds it to the pair's Watch Together
  starting point**, so the reconciler never copies it again. (If the
  pair has no saved starting point, the removal still happens and
  the result line says there was nothing to add it to.)

Each removal lands in `data\debug.log` under `[remove]`, with
Simkl's own confirmed count:

`[remove] removed tt0121955 S29E4 from mirror of pair TK (HTTP 201) — Simkl removed 1 episode(s)`

## Einthusan — Marking Movies Watched On Einthusan.tv

A Brave extension (Brave Simkl Tracker, in its own zip) marks
movies watched on einthusan.tv on TK's Simkl, through this server.
The server side is three endpoints under `/api/einthusan` (search,
saved matches, mark); there is nothing to configure on the server
beyond updating it — the extension holds the Server Address and
Pair Name, and the pair is resolved by name like everything else.

How it behaves:

- First play of a movie shows an on-page panel with the Simkl
  match. Confirming saves the match in `data/einthusan-matches.json`,
  keyed by the movie's Einthusan page id, so the panel never asks
  again for that movie. The saved match is identity only.
- The mark posts when playback position crosses the extension's
  "Mark As Watched At" slider (default 60%). The server checks
  TK's Simkl library first — already there means no duplicate
  post. Marks land in `data\debug.log` under `[einthusan]`, with
  Simkl's confirmed count.
- Solo / Together for Einthusan is chosen in the extension, not
  on the server: the toolbar popup holds the default, the on-page
  panel can override it per movie, and the choice is saved with
  the match in the same file. A Together mark also posts the
  movie to the pair's mirror account (the mirror sign-in saved
  on the pair), deduped against the mirror library first; the
  mark response reports the mirror outcome, and mirror results
  land in the same `[einthusan]` log lines. This is fully
  independent of Stremio's Watch Together, its starting point,
  and the Solo.bat / Together.bat switch — none of those are
  read or changed by Einthusan marks, and a mirror failure never
  fails the mark on TK's own Simkl. The reconciler does not read
  the matches file.

## Step 8 — Install The Addon In Stremio Kai

Per person, on their own machine, from their own configure session:

1. Connect Stremio + Simkl as in Steps 5/6 (the browser must hold that
   person's connections so the link is built from them).
2. Use the page's install action to install the addon into Stremio Kai.
3. The addon gives live sync while watching. It is a fast path — the
   reconciler is the safety net, so a watch is still recorded even if
   the addon path missed it.

One caveat: reconnecting Simkl in the browser later (Step 9) issues a
new token and kills the token inside an older install link. If Stremio
catalogs from this addon stop loading, repeat this step to install a
fresh link.

## Ange's Addon Over Tailscale (HTTPS)

Step 8 works for TK on the PC itself (loopback gets a pass), but
Ange's Stremio on her laptop refuses the install link from Step 6:
Stremio rejects plain-HTTP addon addresses on the LAN, so her addon
was never installed and her watching is covered by the reconciler
alone. Tailscale Serve fixes exactly that: it gives the PC a real
HTTPS address — `https://<pc>.<tailnet>.ts.net` — that proxies to
this server and is reachable **only inside your tailnet**. Stremio
accepts HTTPS install links, so her addon installs and her picks
mark her Simkl instantly, like TK's.

Setup, once:

1. Install Tailscale on the PC and on Ange's laptop, signed into
   the **same tailnet** on both.
2. In the Tailscale admin console, make sure **MagicDNS** is on and
   **HTTPS certificates** are enabled for the tailnet (DNS settings).
   Note the PC's Tailscale name — the address is
   `https://<pc-name>.<tailnet-name>.ts.net`.
3. On the PC, publish this server through Serve:

   ```
   tailscale serve --bg 8181
   ```

   (`tailscale serve status` shows it later; `tailscale serve reset`
   undoes it.)
4. In `.env` next to `docker-compose.yml`, set the origin the server
   reports for itself to that HTTPS address:

   ```
   APP_ORIGIN=https://<pc-name>.<tailnet-name>.ts.net
   ```

   then `docker compose up -d` so it takes effect.
5. On Ange's laptop, open the configure page **at the ts.net
   address** — `https://<pc-name>.<tailnet-name>.ts.net` — and
   connect her Stremio + Simkl there if the page asks (her saved
   pair already exists; the browser at this new address just needs
   her connections once so the install link is built from them).
   Generate her install link from that page and paste it into her
   Stremio's add-addon box. Because the address is HTTPS, Stremio
   accepts it.

Day to day: her laptop needs **Tailscale running** when she watches
for her picks to mark instantly (the addon is reached over the
tailnet). When Tailscale is off or she's away from it, nothing is
lost — the reconciler still covers her pair on its schedule, as it
does today.

**Security — read before changing anything here:**

- **Use Serve, never Funnel.** Serve is tailnet-only: only your own
  devices can even see the address. Funnel publishes to the public
  internet — **never** enable it for this server. The pair-saving
  API on it has no login of its own, and addon install links are
  bearer secrets (anyone holding one holds the account's sync).
- **Never port-forward 8181** (or the container's port) on the
  router, for this or any other reason. Tailscale needs no open
  ports.
- Treat the ts.net address like the LAN address: fine for your own
  devices, not something to post or share.

## Step 9 — Checking That It Works

- **Status file:** `data\status.json` in this folder (plain text, no
  tokens) shows per pair: last run, last success, how many movies and
  episodes were added, and `needsReauth` if a token was rejected.
- **Container logs:** `docker compose logs -f` — reconciler lines start
  with `[reconciler]`.
- **Configure page:** the **Pairs On This Server** list in the Save Pair
  section shows the same status.

## Step 10 — If A Pair Says Needs Reconnect

A Simkl access token lasts 7 days; the server refreshes it on its own.
`needsReauth: true` means a refresh failed or the token was revoked
(for example at simkl.com/settings/connected-apps). Fix: repeat that
person's Step 5/6 — reconnect Simkl in the browser and Save Pair again
with the same pair name. Nothing is lost; the next reconcile backfills
the gap.

## Debug Log

The server keeps a debug log at `data\debug.log` in the project folder
(`E:\Projects\SimklStremio\data\debug.log`). It records what the server
actually decided, line by line:

- Every reconcile run: the watched movies and episodes found in Stremio,
  which ones were added to Simkl, which were already there, and which
  were skipped — with the reason for each skip.
- Watch Together: the starting-point snapshot in use, which items it
  held back, which were already on the second account, and which were
  posted to it.
- Every live stream pick through the addon: the item, which accounts a
  write was tried for, and whether Simkl accepted it. With Watch
  Together on, the instant mirror's decision for that pick is there
  too (`mirror posted`, `mirror excluded (in baseline)`, or
  `mirror failed` with the reason).
- Token refreshes and errors, in full.

Write lines carry Simkl's own confirmation as well as what was sent:
a line like `POST /sync/history — 0 movie(s), 1 show(s) → HTTP 201 —
Simkl added 1 episode(s)` ends with the number of movies and episodes
Simkl reports it actually marked. The two counts can differ — an
episode already on the account is sent but adds nothing — and
Simkl's count is the one that proves what landed: had a whole show
been marked by mistake, that count would show every episode, not
just the one that was watched.

The log never contains Simkl tokens, Stremio keys, or addon links. Item
IDs, counts, and status codes only. When it passes 5 MB it rolls over
once to `debug.log.1` and starts fresh. It is on by default; set
`DEBUG_LOG=0` in `.env` to turn it off.

If a watch does not land where it should, send this file — it shows
exactly where the item stopped.

## Rules Baked Into This Build

- Only watched movies and episodes are written to Simkl (completed).
  Plan-to-watch, watching, on-hold and dropped lists are never touched.
- Sync writes are add-only. The single delete anywhere in the build
  is the manual, per-item undo on the configure page (see "Undo —
  Remove From Simkl History") — nothing automatic ever removes
  anything, and there are no list moves, ever.
- Home network and tailnet only. Do not port-forward this container
  or put it on a public address — the pair-saving page has no login
  of its own.
