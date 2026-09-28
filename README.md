# ParkAlert 🎢

Mobile-first PWA that pings your phone the moment a Disney ride goes down or comes back up, with how long it was down and, when it goes down, how long outages like it usually last. Built for two phones sharing one trip.

## How it works

```
ThemeParks.wiki API ──(poll every 60s)──▶ Node server ──(on status transition)──▶ ntfy.sh ──▶ your phones
        │                                    │
        └──(history, once a day)─────────────┤
                                             └──▶ serves the PWA dashboard (down rides, watch list, mutes)
```

- **Zero npm dependencies.** Plain Node 18+ (`fetch` built in). Deploys to Railway in minutes; runs anywhere Node runs.
- **Storage**: flat JSON files (trips, last-known ride state, past outages). Locally in `data/`; on Railway on an attached volume so it survives restarts *and* redeploys.
- **Push**: each trip gets a unique [ntfy.sh](https://ntfy.sh) topic (`parkalert-<code>-<random>`). The server POSTs to it on transitions; phones subscribe via the ntfy app (or ntfy web). No accounts anywhere.

## Run it locally

```sh
node server/index.js          # http://localhost:3000
PORT=8080 node server/index.js
npm test                      # node's built-in test runner, no installs
```

## Deploy on Railway (HTTPS included)

Railway gives you an always-on host with automatic HTTPS: no certs, DNS, or reverse proxy. `railway.json` in this repo configures the build (Nixpacks), start command, and a healthcheck; nothing else is needed for a zero-dependency Node app.

1. Sign up at [railway.com](https://railway.com) (trial: one-time $5 credit, 30 days, no card).
2. Install the CLI and deploy from this directory:
   ```sh
   npm i -g @railway/cli   # or: brew install railway
   railway login
   railway init            # create a new project
   railway up              # build + deploy
   ```
   (Alternative: push to GitHub and use "Deploy from GitHub repo" in the dashboard for auto-deploys on push.)
3. **Attach a volume** (required, because the container filesystem is wiped on every redeploy): in the Railway dashboard, right-click the service → **Attach volume**, mount path `/data`. The app picks it up automatically via `RAILWAY_VOLUME_MOUNT_PATH`; trips and outage history survive redeploys.
4. **Generate the public URL**: service → Settings → Networking → **Generate Domain**. You get `https://<name>.up.railway.app`, which is what phones load. HTTPS is automatic.
5. Make sure **Serverless / App Sleep is OFF** for the service (Settings → Deploy). The 60-second poller must stay awake or transitions get missed.

No environment variables are required. Optional ones:

- `THEMEPARKS_API_KEY`: a free ThemeParks.wiki key. Without one the history archive allows the last 7 days; with one, 30. More history means better estimates sooner.
- `HISTORY_DAYS`: how far back to backfill, if you want less than the key allows.
- `DATA_DIR`: override the data location; not needed when a volume is attached.
- `NTFY_BASE`: a self-hosted ntfy server instead of ntfy.sh.
- `PUBLIC_URL`: the app's address, for the tap-to-open link on alerts. Not needed on Railway.

**Cost**: this app uses ~64 MB RAM and near-zero CPU, about **$0.50 to $0.80/month** of Railway credit. The history backfill is a handful of requests a night and a few KB of storage a day, so it does not change that. The $5 trial covers a vacation easily. After the trial you drop to the Free plan's $1/month credit, which *probably* covers it but is tight; for a trip you care about, the $5/mo Hobby plan for that month is the safe option (volumes on trial accounts are deleted 30 days after trial credits expire, so upgrade before then if you want to keep trip data).

## Simulating a transition (testing pushes)

Fire a fake transition through the real notification pipeline (fan-out to every phone on the trip, all mute rules apply; message is marked `SIMULATED TEST`):

```sh
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"up"}'    # "back up, was down 47 min"
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"down"}'  # "is down", with a reopen estimate
```

Response tells you what happened: `{"ride":"Astro Orbiter","sent":2,"skipped":0}`. `sent:0` usually means the trip is muted, including the automatic mute after park closing.

## Using it

1. Open the app and pick your park, or tap **Use my location**. Location is only asked for when you tap it.
2. A short setup sheet opens: install the free **ntfy** app, subscribe to your trip (one tap on Android; copy and paste on iPhone), then send a test and confirm it arrived. Until you do, the header says **Set up alerts** instead of **Alerts on**, so a phone that will never be pinged is obvious.
3. Add to home screen for the full-screen experience.
4. **Second phone**: Trip tab → **Invite someone**, or read them the 6-letter code to type on the setup screen. Tapping an invite while already on another trip switches trips with an Undo.

The app has three tabs. **Down now** shows what is down, how long, and the reopen range, with a "Back up recently" list below so an alert opened late still makes sense. **Rides** lists every ride with its wait and one switch for whether you get alerts about it, plus search. **Trip** holds the code, alert setup, pause, park and leave.

Almost everything opens something:

- **Any ride** (a down card, a row in Rides, a "back up" row) opens its sheet: the reopen range with the likely clock times and how it was worked out, a chart of today's wait times you can scrub with a finger, what the ride did today, and its last week in the archive (outages per day, typical and longest, recent outages).
- **The park name** opens today's hours (including evening events), counts for right now and today, and the rides with the most outages this week.
- **A park-wide hold** opens the rides caught in it and how long holds usually last.
- **Pull down** on any list to refresh.

### Notifications

- 🔴 `Space Mountain is down` on OPERATING → DOWN, with a line like `Usually back in 10 to 40 min`
- 🟢 `Space Mountain is back up` with `Was down 47 min` on DOWN → OPERATING
- Three or more alerts of one kind in the same minute become one push (`6 rides just went down`), so a storm hold is one buzz rather than eleven.
- Tapping an alert opens the app. The link comes from `RAILWAY_PUBLIC_DOMAIN`, or `PUBLIC_URL` anywhere else.
- Pausing (1 hour, 3 hours, until tomorrow morning) applies to everyone on the trip; the app says so, and points to muting the subscription in ntfy to quiet one phone only.
- Alerts stop on their own after the park's last close of the day, which includes ticketed evening events. On a Halloween party night Magic Kingdom closes at 6pm but alerts continue until the party ends at midnight.
- Anti-flicker: a repeat alert for the same ride in the same direction within 5 minutes is suppressed (`NOTIFY_COOLDOWN_MS` in `server/poller.js`), so a ride flapping between statuses can't spam your phones; the dashboard always shows live truth.
- Follow list: every ride by default. It is shared across the trip, and each park keeps its own, so hopping parks and back restores it.

## Reopen estimates

Nobody publishes when a ride will reopen, so ParkAlert estimates it from how long past outages lasted. It gives a range, never a countdown. In real Magic Kingdom history the typical time left barely shrinks as an outage drags on, so "back at 3:40" would be wrong most of the time.

**Where the history comes from.** Once an hour the server checks whether any finished park day is missing from `data/history.json` and fetches it from the ThemeParks.wiki history archive, one request per park per day. A day is fetched after 6am park time the next morning, so late closes are included. Estimates only ever read this local copy, so a slow archive never delays an alert.

**Outages are sorted by kind**, because each behaves differently and mixing them would make every estimate worse:

- **Breakdowns**: one ride goes down while running. Most outages.
- **Park-wide holds**: five or more running rides go down within ten minutes of each other. In Florida this is nearly always lightning; two September storms at Magic Kingdom each closed 11 outdoor rides inside two minutes, and those holds ran about three times as long as a typical breakdown there (median 49 min against 14). A fireworks or power hold looks the same in the data, so the app says "park-wide hold" rather than claiming weather. A free weather API was tried and missed both storms, so the cluster itself is the signal.
- **Delayed openings**: the ride went DOWN without having been running first. Several often fail to open together at rope drop, which is not a hold.
- **Blips** under a minute are dropped.

**How the range is worked out.** For breakdowns and delayed openings the ride's own history is used once it has 8 or more outages; until then, the whole park's. Holds pool the park, then every park. The math is a Kaplan-Meier estimate: outages that never reopened that day count as "lasted at least this long" instead of being dropped, which would make estimates too short. The range is the 25th to 75th percentile of time remaining given how long the ride has already been down, so it updates as the outage goes on. With fewer than 5 comparable outages it says nothing. If the ride has been down longer than nearly every past outage it says so instead of inventing a number. When 10% or more of comparable outages lasted the rest of the day, it says that too.

The dashboard shows how many past outages each range rests on. Six and a hundred are not the same claim.

## Notes & limits

- **HTTPS**: geolocation and PWA install require a secure context. Railway's `*.up.railway.app` domain is HTTPS out of the box; `localhost` also counts for local dev. GPS denied/unavailable degrades gracefully to the manual picker.
- **ntfy topics are the security model**: anyone with the topic name can read/write it. The random suffix makes it unguessable; treat trip links like a shared secret.
- **Adding parks**: append to `server/parks.js` with the park's timezone (entity IDs from `https://api.themeparks.wiki/v1/destinations`).
- Statuses other than OPERATING/DOWN (CLOSED, REFURBISHMENT) never trigger notifications; only the two transitions above do.
- Trips nobody has opened in three weeks stop being polled, which is most of what hosting costs. Opening the app again resumes them.
- Times are shown in the park's own time zone, so planning from home still reads like the park clock.
- Estimates are only as good as the history behind them. The first week after a fresh deploy runs on 7 days (30 with a key), and the archive grows by a day each night from there.

Built by Austin Vodrazka with Claude.
