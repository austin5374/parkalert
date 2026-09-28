# ParkAlert 🎢

Mobile-first PWA that pings your phone the moment a Disney ride goes down or comes back up, with how long it was down and, when it goes down, how long outages like it usually last. Built for two phones sharing one trip.

## How it works

```
ThemeParks.wiki API ──(poll every 60s)──▶ Node server ──(on status transition)──▶ ntfy.sh ──▶ your phones
        │                                    │
        └──(history, once a day)─────────────┤
                                             └──▶ serves the PWA dashboard (down rides, watch list, mutes)
```

- **No runtime dependencies.** Plain Node 22+. Deploys to Railway in minutes; runs anywhere Node runs. ESLint is the only dev dependency, for `npm run lint`.
- **Storage**: flat JSON files (trips, last-known ride state, past outages). Locally in `data/`; on Railway on an attached volume so it survives restarts *and* redeploys.
- **Push**: each trip gets a unique [ntfy.sh](https://ntfy.sh) topic (`parkalert-<code>-<random>`). The server POSTs to it on transitions; phones subscribe via the ntfy app (or ntfy web). No accounts anywhere.

## Getting started

You need **Node 22 or newer** (CI runs 22 and 24) and git. Nothing else.

```sh
git clone https://github.com/austin5374/parkalert.git
cd parkalert
npm install        # only installs ESLint; the app itself needs nothing
npm start          # http://localhost:3000
```

Open http://localhost:3000, pick a park, and you have a trip. `localhost` counts as a secure context, so location and the service worker work too.

| Command | What it does |
|---|---|
| `npm start` | Runs the server on port 3000 (`PORT=8080 npm start` for another). It polls ThemeParks.wiki every minute for parks with a trip, and backfills outage history hourly. |
| `npm test` | Node's built-in test runner over `tests/*.test.js`. No network: the tests stand up fake ThemeParks.wiki and ntfy servers. |
| `npm run lint` | ESLint over the server, tests, client and service worker. |
| `npm run check` | Lint, then tests. What CI runs on every push (`.github/workflows/ci.yml`). |

Data goes in `data/` (git-ignored): `trips.json` (readable), `state.json` (live ride state, waits and today's transitions) and `history.json` (the outage archive). Delete the folder to start from scratch.

### Project layout

```
server/
  index.js        HTTP server: API routes, static files, security headers, rate limits
  config.js       every environment setting, with its default
  poller.js       60s polling, transition detection, anti-flicker, alert wording and fan-out
  notify.js       ntfy publishing
  themeparks.js   ThemeParks.wiki client and schedule parsing
  history.js      nightly backfill of the outage archive
  episodes.js     turns a day of history into outages, sorted by kind
  predict.js      Kaplan-Meier reopen estimates
  insights.js     numbers for the ride and park detail sheets
  store.js        JSON persistence, trip codes
  validate.js     request validation
  ratelimit.js    per-client token buckets
  time.js         park-local dates
  parks.js        the parks, with time zones, resorts and geofences
public/
  index.html, style.css, app.js   the PWA (no framework, no build step)
  time.js         DOM-free helpers (dates, durations), loaded before app.js and unit-tested
  sw.js           service worker: the app shell works offline
  manifest.webmanifest   install metadata and icons
  icons/          icon.svg is the source; the PNGs are rendered from it
tests/            node:test suites; fakes.js stands in for ThemeParks.wiki and ntfy
```

### Working without the real API

`THEMEPARKS_BASE` points the server at any ThemeParks.wiki-compatible API: a local fake, or a caching mirror. `NTFY_BASE` does the same for pushes. `tests/fakes.js` shows the shape both need.

## Deploy on Railway (HTTPS included)

Railway gives you an always-on host with automatic HTTPS: no certs, DNS, or reverse proxy. `railway.json` in this repo configures the build (Nixpacks), start command, and a healthcheck; nothing else is needed.

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
6. Optional: point an uptime monitor at `https://<name>.up.railway.app/api/health`. It returns 503 if any park a trip is watching has gone 5 minutes without a successful poll, i.e. alerts have quietly stopped.

### Settings

No environment variables are required.

| Variable | Default | What it's for |
|---|---|---|
| `THEMEPARKS_API_KEY` | none | A free ThemeParks.wiki key. Without one the history archive allows the last 7 days; with one, 30. More history means better estimates sooner. |
| `HISTORY_DAYS` | 7, or 30 with a key | How far back to backfill, if you want less than the key allows. |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` | The app's address, for the tap-to-open link on alerts. Not needed on Railway. |
| `DATA_DIR` | the Railway volume, else `./data` | Where the JSON files live. |
| `NTFY_BASE` | `https://ntfy.sh` | A self-hosted ntfy server instead of ntfy.sh. |
| `THEMEPARKS_BASE` | `https://api.themeparks.wiki/v1` | A stand-in or mirror for the ThemeParks.wiki API. |
| `PORT` | `3000` | Set by Railway. |

**Cost**: the server uses about 90 MB of RAM (measured on Node 22), a little more as the outage archive fills toward a year (roughly 15 MB on disk), and near-zero CPU. Railway bills mostly by memory, so expect around $1/month of usage at their rates as of this writing. The $5 trial covers a vacation easily. After the trial you drop to the Free plan's $1/month credit, which is tight; for a trip you care about, the $5/mo Hobby plan for that month is the safe option (volumes on trial accounts are deleted 30 days after trial credits expire, so upgrade before then if you want to keep trip data).

## Simulating a transition (testing pushes)

Fire a fake transition through the real notification pipeline. It goes to every phone on this trip only, all mute rules apply, and the message is marked `SIMULATED TEST`:

```sh
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"up"}'    # "back up, was down 47 min"
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"down"}'  # "is down", with a reopen estimate
```

Response tells you what happened: `{"ride":"Astro Orbiter","sent":2,"skipped":0}`. `sent:0` usually means the trip is muted, including the automatic mute after park closing. Test and simulated pushes are rate-limited (10 at once, then 30 an hour, per client and per trip), so a `429` means wait a little.

## Using it

1. Open the app and pick your park, or tap **Use my location**. Location is only asked for when you tap it.
2. A short setup sheet opens: install the free **ntfy** app, subscribe to your trip (one tap on Android; copy and paste on iPhone), then send a test and confirm it arrived. Until you do, the header says **Set up alerts** instead of **Alerts on**, so a phone that will never be pinged is obvious.
3. Add it to your home screen for the full-screen experience: Trip tab → **Add to Home Screen** (Chrome offers its own install prompt; on iPhone the sheet shows where Safari's menu item is).
4. **Second phone**: Trip tab → **Invite someone**, or read them the 6-letter code to type on the setup screen. Tapping an invite while already on another trip switches trips with an Undo.

The app has three tabs. **Down now** shows what is down, how long, and the reopen range, with "Back up recently" and "Closed after an outage" lists below so an alert opened late still makes sense. **Rides** lists every ride with its wait and one switch for whether you get alerts about it, plus search, sorted A–Z or by shortest wait. **Trip** holds the code, alert setup, pause, park and leave.

Almost everything opens something:

- **Any ride** (a down card, a row in Rides, a "back up" row) opens its sheet: the reopen range with the likely clock times and how it was worked out, a chart of today's wait times you can scrub with a finger, what the ride did today, and its last week in the archive (outages per day, typical and longest, recent outages).
- **The park name** opens today's hours (including evening events), counts for right now and today, and the rides with the most outages this week.
- **A park-wide hold** opens the rides caught in it and how long holds usually last.
- **Pull down** on any list to refresh.

With no signal, the app still opens: it shows the last rides it saw, marked `Offline · as of 3:42 PM`, and catches up by itself when the connection is back.

### Notifications

- 🔴 `Space Mountain is down` on OPERATING → DOWN, with a line like `Usually back in 10 to 40 min`
- 🟢 `Space Mountain is back up` with `Was down 47 min` on DOWN → OPERATING
- ⛔ `Space Mountain has closed` with `Down since 2:10 PM, now closed. It may not reopen today` when a down ride switches to CLOSED in the middle of the day (not before opening or around closing, when that is just the park's hours). If it reopens within 8 hours you get `is back up` with the whole outage.
- 🟢 `Seven Dwarfs Mine Train is now open` with `Opened 40 min late` when a ride that missed its opening time finally opens (it went DOWN without having run first, so there was no "down" alert)
- Three or more alerts of one kind in the same minute become one push (`6 rides just went down`), so a storm hold is one buzz rather than eleven. It says "park-wide hold" when most of the rides in it are.
- Tapping an alert opens the app. The link comes from `RAILWAY_PUBLIC_DOMAIN`, or `PUBLIC_URL` anywhere else.
- Pausing (1 hour, 3 hours, until 7am on the park's clock) applies to everyone on the trip; the app says so, and points to muting the subscription in ntfy to quiet one phone only.
- Alerts stop on their own after the park's last close of the day, which includes ticketed evening events. On a Halloween party night Magic Kingdom closes at 6pm but alerts continue until the party ends at midnight. If today's hours can't be fetched, alerts stay on rather than guessing.
- Anti-flicker: a repeat alert for the same ride in the same direction within 5 minutes is held back (`NOTIFY_COOLDOWN_MS` in `server/poller.js`), so a ride flapping between statuses can't spam your phones. It is held, not dropped: once the 5 minutes pass, it goes out if the ride is still that way, so the last alert you got always matches reality.
- After a gap in polling (the trip hopped to another park and back, or the server or the API was down for more than 15 minutes), the next poll starts afresh with no alerts, because nobody knows when things changed in between. The dashboard shows the current state straight away.
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

## API

Everything the app uses, all JSON. A trip code is the only credential.

| Route | |
|---|---|
| `GET /api/parks` | The parks the app knows. Railway's deploy healthcheck. |
| `GET /api/health` | Last successful poll per watched park; 503 once one is 5 minutes stale. |
| `POST /api/trips` `{parkId}` | Create a trip. Returns its code and ntfy topic. |
| `GET /api/trips/:code` | The trip. |
| `PATCH /api/trips/:code` | Any of `parkId`, `watched` (null or ride ids), `mute` (null or `{until}`), `rideMutes`. Validated as a whole: one bad field rejects the request. |
| `GET /api/trips/:code/dashboard` | Park, hours, every ride with status, wait and (if down) reopen outlook, and recent transitions. |
| `GET /api/trips/:code/rides/:id` | One ride's detail: outlook, today's changes and waits, archive history. |
| `GET /api/trips/:code/park` | Today's counts and the week's least reliable rides. |
| `POST /api/trips/:code/test` | A test push to this trip. |
| `POST /api/trips/:code/simulate` `{type: "up" \| "down"}` | See above. |

Bad input is a 400 that says why, an oversized body a 413, and too many requests a 429 with `Retry-After`.

## Security

- **ntfy topics are the security model**: anyone with the topic name can read/write it. The random suffix makes it unguessable; treat trip links like a shared secret.
- **Rate limits** per client (the last `X-Forwarded-For` entry on Railway): new trips 20 then 20 an hour; test and simulated pushes 10 then 30 an hour, per client and per trip; unknown trip codes 30 then 60 an hour, after which even a right guess waits. Every push leaves from this one server, whose IP ntfy.sh rate-limits, so this keeps one abuser from throttling everyone's alerts. Limits live in memory and reset on restart.
- Every response carries a Content-Security-Policy (same-origin only, no inline scripts), `nosniff`, `no-referrer` and frame denial, plus HSTS over HTTPS.

## Troubleshooting

- **No alerts on one phone**: Trip tab → Alerts on this phone. Send a test; if it doesn't arrive, check that notifications are allowed for ntfy and that the topic you subscribed to matches exactly.
- **`sent: 0` from simulate or no alerts at all**: the trip is paused, the park is past its last close, or the ride isn't followed (Rides tab switch). Check `/api/health` to see whether the park is being polled at all.
- **Header says "reconnecting"**: the server hasn't had a good answer from ThemeParks.wiki for 3+ minutes; `/api/health` shows the last error. Alerts resume on their own when it answers again.
- **Estimates say nothing**: fewer than 5 comparable past outages yet. Set `THEMEPARKS_API_KEY` to backfill 30 days instead of 7.

## Notes & limits

- **HTTPS**: geolocation and PWA install require a secure context. Railway's `*.up.railway.app` domain is HTTPS out of the box; `localhost` also counts for local dev. GPS denied/unavailable degrades gracefully to the manual picker.
- **Adding parks**: append to `server/parks.js` with the park's timezone and the resort to list it under (entity IDs from `https://api.themeparks.wiki/v1/destinations`).
- Only transitions involving DOWN alert: down, back up, opened late, and closed while down. Other status changes (a ride opening on time, going to REFURBISHMENT) don't.
- Trips nobody has opened in three weeks stop being polled and stop getting alerts, which is most of what hosting costs. Opening the app again resumes them. Trips are never deleted.
- Times are shown in the park's own time zone, so planning from home still reads like the park clock.
- Estimates are only as good as the history behind them. The first week after a fresh deploy runs on 7 days (30 with a key), and the archive grows by a day each night from there.

Built by Austin Vodrazka with Claude.
