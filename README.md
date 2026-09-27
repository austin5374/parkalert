# ParkAlert 🎢

Mobile-first PWA that pings your phone the moment a Disney ride goes down — or comes back up (with how long it was down). Built for two phones sharing one trip.

## How it works

```
ThemeParks.wiki API ──(poll every 60s)──▶ Node server ──(on status transition)──▶ ntfy.sh ──▶ your phones
                                             │
                                             └──▶ serves the PWA dashboard (down rides, watch list, mutes)
```

- **Zero npm dependencies** — plain Node 18+ (`fetch` built in). Deploys to Railway in minutes; runs anywhere Node runs.
- **Storage**: flat JSON files (trips + last-known ride state). Locally in `data/`; on Railway on an attached volume so it survives restarts *and* redeploys.
- **Push**: each trip gets a unique [ntfy.sh](https://ntfy.sh) topic (`parkalert-<code>-<random>`). The server POSTs to it on transitions; phones subscribe via the ntfy app (or ntfy web). No accounts anywhere.

## Run it locally

```sh
node server/index.js          # http://localhost:3000
PORT=8080 node server/index.js
```

## Deploy on Railway (HTTPS included)

Railway gives you an always-on host with automatic HTTPS — no certs, DNS, or reverse proxy. `railway.json` in this repo configures the build (Nixpacks), start command, and a healthcheck; nothing else is needed for a zero-dependency Node app.

1. Sign up at [railway.com](https://railway.com) (trial: one-time $5 credit, 30 days, no card).
2. Install the CLI and deploy from this directory:
   ```sh
   npm i -g @railway/cli   # or: brew install railway
   railway login
   railway init            # create a new project
   railway up              # build + deploy
   ```
   (Alternative: push to GitHub and use "Deploy from GitHub repo" in the dashboard for auto-deploys on push.)
3. **Attach a volume** (required — the container filesystem is wiped on every redeploy): in the Railway dashboard, right-click the service → **Attach volume**, mount path `/data`. The app picks it up automatically via `RAILWAY_VOLUME_MOUNT_PATH`; trips survive redeploys.
4. **Generate the public URL**: service → Settings → Networking → **Generate Domain**. You get `https://<name>.up.railway.app` — that's what phones load. HTTPS is automatic.
5. Make sure **Serverless / App Sleep is OFF** for the service (Settings → Deploy) — the 60-second poller must stay awake or transitions get missed.

No environment variables are required. Optional ones: `DATA_DIR` (override data location; not needed when a volume is attached), `NTFY_BASE` (self-hosted ntfy server instead of ntfy.sh).

**Cost**: this app uses ~64 MB RAM and near-zero CPU ≈ **$0.50–0.80/month** of Railway credit. The $5 trial covers a vacation easily. After the trial you drop to the Free plan's $1/month credit — that *probably* covers it but is tight; for a trip you care about, the $5/mo Hobby plan for that month is the safe option (volumes on trial accounts are deleted 30 days after trial credits expire, so upgrade before then if you want to keep trip data).

## Simulating a transition (testing pushes)

Fire a fake transition through the real notification pipeline (fan-out to every phone on the trip, all mute rules apply; message is marked `SIMULATED TEST`):

```sh
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"up"}'    # "back up — was down 47 min"
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"down"}'  # "is down"
```

Response tells you what happened: `{"ride":"Astro Orbiter","sent":2,"skipped":0}`. `sent:0` usually means the trip is muted — including the automatic mute after park closing.

## Using it

1. Open the app → it asks for location once and auto-picks your park (or pick manually / it falls back to the picker if GPS is denied).
2. Install the **ntfy** app ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)), subscribe to your trip's topic (Settings tab → copy topic → "Send test notification" to verify).
3. Add to home screen for the full-screen PWA experience.
4. **Second phone**: Settings → "Share trip link" (or read them the 6-letter code → "join a trip" on the setup screen). Both phones now share the same watch list and both get pinged.

### Notifications

- 🔴 `Space Mountain is down` — on OPERATING → DOWN
- 🟢 `Space Mountain is back up — Was down 47 min` — on DOWN → OPERATING
- Muting: global toggle (bell in the header), "mute 1 hour", per-ride mute (bell on each ride row). Everything auto-mutes after the park's published closing time.
- Anti-flicker: a repeat alert for the same ride in the same direction within 5 minutes is suppressed (`NOTIFY_COOLDOWN_MS` in `server/poller.js`), so a ride flapping between statuses can't spam your phones; the dashboard always shows live truth.
- Watch list: all rides by default; unstar rides you don't care about (shared across the trip).

## Notes & limits

- **HTTPS**: geolocation and PWA install require a secure context. Railway's `*.up.railway.app` domain is HTTPS out of the box; `localhost` also counts for local dev. GPS denied/unavailable degrades gracefully to the manual picker.
- **ntfy topics are the security model**: anyone with the topic name can read/write it. The random suffix makes it unguessable; treat trip links like a shared secret.
- **Adding parks**: append to `server/parks.js` (entity IDs from `https://api.themeparks.wiki/v1/destinations`).
- Statuses other than OPERATING/DOWN (CLOSED, REFURBISHMENT) never trigger notifications — only the two transitions above do.
- No reopen-time predictions by design; only elapsed downtime.
