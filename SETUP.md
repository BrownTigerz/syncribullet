# SimklStremio Setup

Self-hosted syncribullet fork. Tracks watched movies and TV episodes from
two Stremio accounts (TK, Ange) to two Simkl accounts. Add-only: nothing
is ever removed from Simkl. A server-side reconciler re-checks both
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
   Turning it off drops the saved starting point. To start over from a
   new moment, save once with Watch Together off, then turn it on and
   save again; the second save records a new starting point.

Re-saving the pair while Watch Together stays on — for example to
reconnect a token — keeps the original starting point. It does not
move forward.

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

The log never contains Simkl tokens, Stremio keys, or addon links. Item
IDs, counts, and status codes only. When it passes 5 MB it rolls over
once to `debug.log.1` and starts fresh. It is on by default; set
`DEBUG_LOG=0` in `.env` to turn it off.

If a watch does not land where it should, send this file — it shows
exactly where the item stopped.

## Rules Baked Into This Build

- Only watched movies and episodes are written to Simkl (completed).
  Plan-to-watch, watching, on-hold and dropped lists are never touched.
- The only Simkl write is adding watched history. No deletes, no list
  moves, ever.
- Home network only. Do not port-forward this container or put it on a
  public address — the pair-saving page has no login of its own.
