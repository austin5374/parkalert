# ParkAlert

Mobile-first PWA that pings your phone the moment a Disney ride goes down or comes back up, with how long it was down and, when it goes down, how long outages like it usually last. When a storm is why, it watches the weather and times the reopening from when the storm passes. It can also ping you when a ride's wait drops to what you'll stand in line for. Built for two phones sharing one trip.

## How it works

```
ThemeParks.wiki API ──(poll every 60s)──▶ Node server ──(on status transition)──▶ Web Push / ntfy.sh ──▶ your phones
        │                                    │
        └──(history, once a day)─────────────┤
Airport weather reports ──(every 5 min)─────▶│
Weather report archive ──(hourly backfill)──▶┤
                                             └──▶ serves the PWA dashboard (down rides, ride alerts, pause)
```

- **No runtime dependencies.** Plain Node 22+. Deploys to Railway in minutes; runs anywhere Node runs. ESLint is the only dev dependency, for `npm run lint`.
- **Storage**: flat JSON files (trips, last-known ride state, past outages). Locally in `data/`; on Railway on an attached volume so it survives restarts *and* redeploys.
- **Push**: the app sends its own notifications with Web Push (VAPID and RFC 8291 encryption, done with Node's crypto, no library): Android and desktop browsers anywhere, iPhone once ParkAlert is on the Home Screen (iOS 16.4 and later). Each phone registers on the trip, so each can be paused on its own. Every trip also keeps its [ntfy.sh](https://ntfy.sh) topic (`parkalert-<code>-<random>`) for phones that use the ntfy app instead. No accounts anywhere.

## Getting started

You need **Node 22 or newer** (CI runs 22 and 24) and git. Nothing else.

```sh
git clone https://github.com/austin5374/parkalert.git
cd parkalert
npm ci             # only installs ESLint; the app itself needs nothing
npm start          # http://localhost:3000
```

Open http://localhost:3000, pick a park, and you have a trip. `localhost` counts as a secure context, so location and the service worker work too.

| Command | What it does |
|---|---|
| `npm start` | Runs the server on port 3000 (`PORT=8080 npm start` for another). It polls ThemeParks.wiki every minute for parks with a trip, and backfills outage history hourly. |
| `npm test` | Node's built-in test runner over `tests/*.test.js`. No network: the tests stand up fake ThemeParks.wiki and ntfy servers. |
| `npm run lint` | ESLint over the server, tests, client and service worker. |
| `npm run check` | Lint, then tests. What CI runs on every push (`.github/workflows/ci.yml`). |
| `npm run backtest` | Scores the reopen ranges against this server's own archive: each past outage estimated from earlier days only, then checked against when it really reopened. Run it where the data is: on Railway, open a shell on the service (`railway ssh`) and run it there. |

Data goes in `data/` (git-ignored): `trips.json` (readable), `state.json` (live ride state, waits, today's transitions, and how recent estimates turned out), `history.json` (the outage archive) and `weather.json` (a year of airport weather reports). Delete the folder to start from scratch.

### Project layout

```
server/
  index.js        HTTP server: API routes, static files, security headers, rate limits
  config.js       every environment setting, with its default
  poller.js       60s polling, transition detection, alert wording and fan-out
  gate.js         anti-flicker and incidents: which transitions phones hear about, and when
  messages.js     what each push says
  waitalerts.js   "tell me when the wait drops to N min" alerts
  deliver.js      sends each alert: the trip's ntfy topic, and every phone on the app's own notifications
  webpush.js      Web Push: VAPID signing and RFC 8291 encryption, no library
  notify.js       ntfy publishing
  themeparks.js   ThemeParks.wiki client and schedule parsing
  history.js      nightly backfill of the outage archive
  episodes.js     turns a day of history into outages, sorted by kind
  predict.js      Kaplan-Meier reopen estimates, and the after-the-storm ones
  metar.js        reads lightning and rain out of airport weather reports
  weather.js      fetches and keeps those reports; storm and rain timelines per park
  causes.js       was it the weather, which rides the weather shuts, when it cleared
  weatheroutlook.js  ties the above to a live down ride
  scorecard.js    scores each estimate when its ride reopens
  backtest.js     scores the method against the archive (npm run backtest)
  insights.js     numbers for the ride and park detail pages, and wait trends
  crowds.js       wait profiles, headliners, typical waits, crowd reading, best times, lines building (pure)
  crowdstate.js   those applied to the archive and the live park
  store.js        JSON persistence, trip codes
  validate.js     request validation
  ratelimit.js    per-client token buckets
  time.js         park-local dates
  parks.js        the parks, with time zones, resorts, geofences and weather stations
scripts/
  backtest.js     the npm run backtest command
public/
  index.html, style.css, app.js   the PWA (no framework, no build step; screens patch in place)
  time.js         DOM-free helpers (dates, durations), loaded before app.js and unit-tested
  sw.js           service worker: one cache per version, offline shell, and the app's notifications
  manifest.webmanifest   install metadata and icons
  icons/          icon.svg is the source; the PNGs are rendered from it
tests/            node:test suites; fakes.js stands in for ThemeParks.wiki, ntfy and both weather feeds
```

### The stress lab

`npm run lab` runs the real server against a fake park you control, with nothing leaving your machine. The control panel at `http://localhost:4100` has a button per scenario: a breakdown, a wave of three, a storm hold and its clearing, a flapping ride, rides late to open, a ride that closes for the day, a crowd surge, the park closing, the ride feed failing or crawling, a ride vanishing from the feed, and everything at once. It lists every push the server sends. The app runs at `http://localhost:3000/?trip=MKLABS` (also `DLLABS` and `EPLABS`), polling every 10 seconds, over 30 days of seeded outage history and wait profiles. One Magic Kingdom ride has been down for five hours, and a few rides have hostile names (markup, a very long name, emoji, quotes). `npm run lab -- --auto` fires a random scenario every 90 seconds. The data lives in `.lab-data/` and is reseeded on each run unless you add `--keep`.

### Working without the real API

`THEMEPARKS_BASE` points the server at any ThemeParks.wiki-compatible API: a local fake, or a caching mirror. `NTFY_BASE` does the same for pushes, and `WEATHER_BASE` and `WEATHER_ARCHIVE` for the two weather feeds. `tests/fakes.js` shows the shape each needs.

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
6. Optional: point an uptime monitor at `https://<name>.up.railway.app/api/health`. It returns 503 if any park a trip is watching has gone 5 minutes without a successful poll, i.e. alerts have quietly stopped. It says only whether all is well; set `HEALTH_TOKEN` and add `?token=<it>` to see each park and its last error.

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
| `WEATHER_BASE` | `https://aviationweather.gov/api/data` | Live airport weather reports (NOAA's Aviation Weather Center). |
| `WEATHER_ARCHIVE` | `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py` | Past airport weather reports (Iowa State's ASOS archive). |
| `HEALTH_TOKEN` | none | Unlocks the per-park detail in `/api/health`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | made on first start | The Web Push key pair (base64url). Normally created once and kept in `vapid.json` on the volume; changing it would cut off every phone's notifications until it re-subscribes. |
| `PORT` | `3000` | Set by Railway. |

**Cost**: the server uses about 80 to 90 MB of RAM (measured on Node 22 and 24 in September 2026, with a week of archive), a little more as the outage archive fills toward a year (roughly 15 MB on disk), and near-zero CPU. Railway bills mostly by memory, so expect around $1/month of usage at their rates as of this writing. The $5 trial covers a vacation easily. After the trial you drop to the Free plan's $1/month credit, which is tight; for a trip you care about, the $5/mo Hobby plan for that month is the safe option (volumes on trial accounts are deleted 30 days after trial credits expire, so upgrade before then if you want to keep trip data).

## Simulating a transition (testing pushes)

Fire a fake transition through the real notification pipeline. It goes to every phone on this trip only, all mute rules apply, and the message is marked `SIMULATED TEST`:

```sh
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"up"}'    # "back up, was down 47 min"
curl -X POST https://<your-app>.up.railway.app/api/trips/<CODE>/simulate -d '{"type":"down"}'  # "is down", with a reopen estimate
```

Response tells you what happened: `{"ride":"Astro Orbiter","sent":2,"skipped":0}`. `sent:0` usually means the trip is muted, including the automatic mute after park closing. Test and simulated pushes are rate-limited (10 at once, then 30 an hour, per client and per trip), so a `429` means wait a little.

## Using it

1. Open the app and pick your park, or tap **Use my location**. Location is only asked for when you tap it.
2. A short setup sheet opens: tap **Turn on notifications**, allow them, and a test arrives. On iPhone this needs ParkAlert on the Home Screen first, and the sheet says so and shows how. The free **ntfy** app is the fallback, one tap away under "Or use the ntfy app instead". Until a phone is set up, the header says **Set up alerts** instead of **Alerts on**, so a phone that will never be pinged is obvious. A phone that already allows notifications joins a new trip's alerts on its own.
3. Add it to your home screen for the full-screen experience: Trip tab → **Add to Home Screen** (Chrome offers its own install prompt; on iPhone the sheet shows where Safari's menu item is).
4. **Second phone**: Trip tab → **Invite someone**, or read them the 6-letter code to type on the setup screen. Tapping an invite while already on another trip asks first, and an invite opened with no signal is kept until the phone reconnects.

The app has three tabs. **Down now** opens with how crowded the park is, then shows what is down, how long, whether it's worth waiting, and the reopen range, with "Back up recently" and "Closed after an outage" lists below so an alert opened late still makes sense, and up to four rides whose wait is well under their usual for this hour ("Shorter than usual right now"). The Home Screen icon carries a badge with the number of rides with alerts on that are down, where the phone allows it. **Rides** lists every ride with its wait and one switch for whether you get alerts about it (attractions that never post a wait, such as a castle, a gallery or a play area, are listed apart under "Other attractions" and never alert), plus search, a filter (all, open, down, with alerts) and a sort toggle beside the search field (A–Z, or shortest posted wait first). A ride with a single rider line or Lightning Lane says so, with the next return time. An arrow beside a wait shows the line growing or shrinking: at least 10 minutes' change over the last half hour. **Trip** holds the code, alert setup, pause, park and leave.

Almost everything opens something:

- **Any ride** (a down card, a row in Rides, a "back up" row) opens its page, which slides in from the right: the reopen range with the likely clock times and how it was worked out, a wait alert (pick 10 to 60 min; you get one push when the posted wait drops that low, today only), a chart of today's wait times you can scrub with a finger, what the ride did today, and its last week in the archive (outages per day, typical and longest, recent outages). Rides with a wait alert set carry a timer badge in the Rides list.
- **The park name** opens today's hours (including evening events), counts for right now and today, the rides with the most outages this week, and how the reopen estimates have done here over the last 14 days.
- **A park-wide hold** opens the rides caught in it and how long holds usually last.
- **Pull down** on a tab to refresh; it says "Updated just now", or why it couldn't. A page whose data fails to load offers Try again.
- **Back** (the chevron, the browser's or Android's, or a swipe from the left edge) steps back a page, to the hold or park a ride was opened from, then to the tab. Each page has its own address (`/ride/<id>`, `/park`, `/hold`). Sheets are only for short tasks (pause, park, leave, alert setup) and close with Back, a swipe down or a tap outside.

With no signal, the app still opens: it shows the last rides it saw, marked `Offline · as of 3:42 PM`, and catches up by itself when the connection is back.

### Notifications

- `Space Mountain is down` on OPERATING → DOWN, with a line like `Often back in 10 to 40 min`
- `Space Mountain is back up` with `Was down 47 min` on DOWN → OPERATING, once it has stayed up for a minute. After an outage of an hour or more the title says so: `Peter Pan's Flight is back up after 5 hr 20 min`
- `Space Mountain has closed` with `Down since 2:10 PM, now closed. It may not reopen today` when a down ride switches to CLOSED in the middle of the day (not before opening or around closing, when that is just the park's hours). If it reopens within 8 hours you get `is back up` with the whole outage.
- `Space Mountain: 25 min wait` with `You asked for 30 min or less` when a wait alert is met. Once per alert; a pause or the park's close holds it rather than using it up. So does every phone on the trip being paused: it counts as sent only when a phone could see it, either on the app's own notifications or on ntfy once a phone there has confirmed a test arrived.
- `Seven Dwarfs Mine Train is now open` with `Opened at 9:40 AM, late` when a ride that missed its opening time finally opens (it went DOWN without having run first, so there was no "down" alert)
- Rides that go down together are one incident: a park-wide hold, or three or more rides in one poll. The incident is one push that leads with the hold, the range and what to do (`Storm hold: 18 rides closed` / `Often back in 45 min to 1 hr 10 min · Ride something else`). As its rides reopen, their "back up"s are gathered a few minutes at a time into `6 of 18 rides are back up`, which replaces the storm's push on the lock screen without a sound, then `All 18 rides are back up` with a buzz. A ride that joins a hold already announced updates that push quietly. A ride still down when the rest of its hold reopens stays in the hold, with the hold's estimate. Several unrelated rides back up (or closed) in the same poll are one push too.
- Tapping an alert opens what it is about: the ride's page, the hold, or Down now. The link carries the trip code, so it opens the right trip even where it lands in Safari rather than the home-screen app. The link comes from `RAILWAY_PUBLIC_DOMAIN`, or `PUBLIC_URL` anywhere else. Pushes carry no emoji tags; the title says what happened.
- Pausing (1 hour, 3 hours, until 7am on the park's clock, or until turned back on) can be for just this phone, when it uses the app's own notifications, or for everyone on the trip. A phone on ntfy can only pause the whole trip, or mute the subscription in the ntfy app.
- The app's own notifications for the same ride, or the same incident, replace each other on the lock screen ("back up" replaces "is down") instead of piling up.
- Alerts stop on their own after the park's last close of the day, which includes ticketed evening events. On a Halloween party night Magic Kingdom closes at 6pm but alerts continue until the party ends at midnight. If today's hours can't be fetched, alerts stay on rather than guessing. The hours are checked against the rides (`server/parkstatus.js`): past the posted close with 40% or more of the rides still running, the park is open late and alerts continue; within its hours with nine rides in ten closed, it has closed early and alerts stop. While the two disagree, the hours are read again every five minutes.
- Anti-flicker: "is down" goes out the moment a ride goes down, unless your phone already thinks it is down. "Back up" waits until the ride has stayed up for a minute (`UP_CONFIRM_MS` in `server/gate.js`). A ride that flickers back and breaks again costs nothing, and the last alert you got stays true: a flapping ride is one "down", then one "back up" once it settles.
- After a gap in polling (the trip hopped to another park and back, or the server or the API was down for more than 15 minutes), the next poll starts afresh with no alerts, because nobody knows when things changed in between. The dashboard shows the current state straight away, and a ride already down then says "down since before" the time it was first seen. After a shorter gap, alerts still go out but say what is known: `Went down between 9:40 and 9:44 AM`, `Was down 2 to 6 min`.
- A ride that is down when it drops out of the ride feed is kept for half an hour, so its return is still "back up". If it stays gone, phones hear `... is no longer listed` instead of being left with "is down".
- Ride alerts: on for the park's ten headliners by default (every ride while the park's archive has under three days), so a first-time guest hears about rides they'd plausibly ride. The rest are one switch away. They are shared across the trip, and each park keeps its own, so hopping parks and back restores them. Attractions that have never posted a wait in the archive never alert.

## Crowds, wait or go, and best times

**Crowd level.** Each park's headliners are the ten rides with the longest typical waits in the archive, and each ride has a typical wait for every hour (the median across archived days). The crowd reading compares the headliners posting a wait now with those same rides' typical waits at this hour, so a ride that closes drops out of both sides and a storm never reads as a quiet park. It needs half of the headliners (at least three) posting. Readings are averaged over 15 minutes, and the words (quieter than usual under 0.85 of usual, about usual, busier than usual from 1.15, much busier than usual from 1.4) change only when two readings in a row agree. During a hold, and for half an hour after it ends, the level pauses: reopening rides post waits that say more about the hold than the crowd. The row reads, for example, `Busier than usual` over `Big rides average about 62 min, usually 50 at 2 PM`, and the park page draws today against a usual day, hour by hour, read the same way. It needs three archived days before it says anything.

**Wait or go.** Each down ride says what to do, not just a range. The same Kaplan-Meier curve behind the range gives the chance it's back within 15, 30 and 60 minutes, drawn as three nested fills on the bar (darkest is soonest) with the percentages beneath. Chances are shown as percentages, except that nothing drawn from a few dozen outages is certain: above 95% reads "Nearly all" (">95%" on the bar's legend) and under 5% "Almost no" ("<5%"). The verdict follows fixed rules, in order: past nearly every outage like it is "Ride something else" (outages that long rarely end soon); if 30% or more like it didn't reopen that day, "Often closed for the day"; if the park closes before half of these reopen, "May not reopen before close"; otherwise 60% or more within 15 minutes is "Worth waiting nearby", half within 30 is "Check back soon", half within the hour is "Ride something nearby", and anything less is "Ride something else". A weather estimate from the 30-minute rule has no curve, so its range decides.

**Best time to ride.** Every archived day is also kept as an hourly wait profile per ride (60 days of them). A ride's page shows its typical wait for each hour and says when it is usually shortest and longest.

**Lines building.** With the Trip tab switch on, the trip gets one alert when the big rides run at least a fifth further over their usual than half an hour ago (and at least 10 minutes longer) at a busier-than-usual time. Waits that rise the way they do every morning don't count, and nothing is compared across a hold. It names up to two rides the trip follows that are well under their usual wait right now. At most once every two hours per trip, counted from when it reached a phone, never while paused or after close.

## Reopen estimates

Nobody publishes when a ride will reopen, so ParkAlert estimates it from how long past outages lasted. It gives a range, never a countdown. In real Magic Kingdom history the typical time left barely shrinks as an outage drags on, so "back at 3:40" would be wrong most of the time.

**Where the history comes from.** Once an hour the server checks whether any finished park day is missing from `data/history.json` and fetches it from the ThemeParks.wiki history archive, one request per park per day. A day is fetched after 6am park time the next morning, so late closes are included. Estimates only ever read this local copy, so a slow archive never delays an alert.

**Outages are sorted by kind**, because each behaves differently and mixing them would make every estimate worse:

- **Breakdowns**: one ride goes down while running. Most outages.
- **Park-wide holds**: five or more running rides go down within three minutes of each other. In Florida this is nearly always lightning; two September storms at Magic Kingdom each closed 11 outdoor rides inside two minutes, and those holds ran about three times as long as a typical breakdown there (median 49 min against 14). A fireworks or power hold looks the same in the ride data; the weather reports (below) tell them apart. Live, a ride's kind is settled the first poll it is seen down and kept until it reopens, so a wave of breakdowns minutes later never turns advice already given into a hold's. A ride settled as a breakdown joins a hold only when the weather reported lightning as it went down. Every ride in a hold gets the hold's one estimate.
- **Delayed openings**: the ride went DOWN without having been running first. Several often fail to open together at rope drop, which is not a hold.
- **Blips** under a minute are dropped.

**How the range is worked out.** For breakdowns and delayed openings the ride's own history is used once it has 8 or more outages; until then, the whole park's (and for delayed openings, then every park's). Holds pool the park, then every park. The math is a Kaplan-Meier estimate: outages that never reopened that day count as "lasted at least this long" instead of being dropped, which would make estimates too short. The range is the 25th to 75th percentile of time remaining given how long the ride has already been down, so it updates as the outage goes on. Since that is the middle half, it reads "Often back in", not "usually" or "likely". A pool needs 5 comparable outages. With no history anywhere yet (a new server), a built-in prior shaped like Walt Disney World's outages (breakdowns a median of 14 min, holds 49, delayed openings 20) stands in, and the card says so. If the ride has been down longer than nearly every past outage it says so instead of inventing a number, and advises riding something else. When 10% or more of comparable outages lasted the rest of the day, it says that too, as one rounded percentage everywhere it appears.

The dashboard shows how many past outages each range rests on. Six and a hundred are not the same claim.

### When the weather is why

Disney closes outdoor rides while there is lightning within about 10 miles and reopens them about 30 minutes after the last strike. So for a storm outage, how long the ride has been down says little; when the storm ends says nearly everything. ParkAlert watches for that.

**The weather source** is the nearest airport weather stations: Kissimmee (KISM) and Orlando International (KMCO) for Walt Disney World, Fullerton (KFUL) and John Wayne (KSNA) for Disneyland. Their reports say plainly when a thunderstorm is at the airport or in the vicinity (within about 10 miles, the same distance the parks use) and when it is raining, and a special report goes out the moment a storm starts or ends, with the minute. An earlier try with a free weather API missed both of those September storms; these reports are what the airport actually saw. Live reports come from NOAA's Aviation Weather Center every 5 minutes for parks someone is watching; past reports from Iowa State's archive for the same days as the outage archive, so the app can learn from past storms. Both are free and keyless.

**Only the rides the weather shuts count.** A ride is weather-exposed once the archive shows it going down in a park-wide hold or as a storm arrived on two or more days, so indoor rides that keep running through storms never get storm estimates. Some rides also close for rain with no lightning, and stay closed until the track dries: Test Track is known by name, and others are learned the same way from outages that start in rain.

**How the estimate works.** While the storm (or, for a rain ride, the rain) goes on, the range is how long storms here usually last plus how long after one this ride usually reopens, and the ride page says "Lightning still nearby" or "Still raining". Once it has passed, the range is timed from when it passed: "Storm passed at 3:12 PM. Often back in 25 to 35 min", from that ride's own past storms once it has 5, else the park's, else the 30-minute rule. Weather outages are also taken out of the breakdown history, so a storm day no longer stretches every breakdown estimate.

**How close it gets.** After a storm passes, the ranges should be tight (about 10 minutes wide on test data) because the reopening follows a rule. The park page shows how wide they really run. Before it passes, nobody knows when a storm will end, so the range is wider. Breakdowns stay wide (often 20 minutes or more) because a sensor fault and a stuck vehicle look the same from outside; no data this app can see says which it is.

**Checking it.** Each estimate is written down when it is made (when the ride goes down, and again when the weather clears) and scored when the ride reopens. The park page shows the last 14 days: how many reopenings, how often inside the range (once a kind has 10 of them; before that, "Not enough reopenings yet"), and how wide the ranges were. About half inside is right for a range that is the middle half; much more means ranges are wider than they need be. `npm run backtest` does the same over the whole archive.

## API

Everything the app uses, all JSON. A trip code is the only credential.

| Route | |
|---|---|
| `GET /api/parks` | The parks the app knows. Railway's deploy healthcheck. |
| `GET /api/health` | `ok`, and 503 once a watched park is 5 minutes stale. With `?token=` (`HEALTH_TOKEN`), each park's last poll and error. |
| `POST /api/trips` `{parkId}` | Create a trip. Returns its code and ntfy topic. |
| `GET /api/trips/:code` | The trip. |
| `PATCH /api/trips/:code` | Any of `parkId`, `watched` (null or ride ids), `mute` (null or `{until}`), `rideMutes`. Validated as a whole: one bad field rejects the request. |
| `GET /api/trips/:code/dashboard` | Park, hours, every ride with status, wait, usual wait at this hour, whether it is an attraction that never posts a wait (`other`), and (if down) reopen outlook, and recent transitions. |
| `GET /api/trips/:code/rides/:id` | One ride's detail: outlook, today's changes and waits, archive history. |
| `GET /api/trips/:code/park` | Today's counts, the week's least reliable rides, and how the reopen estimates scored over the last 14 days. |
| `PUT /api/trips/:code/wait-alerts/:rideId` `{max}` | Push once today when the ride's wait is `max` minutes (5 to 240) or less. `DELETE` removes it. |
| `POST /api/trips/:code/test` | A test push to this trip. |
| `GET /api/push-key` | The server's VAPID public key, for subscribing. |
| `POST /api/trips/:code/devices` `{subscription}` | Register this phone for the app's own notifications (idempotent by endpoint). Only known push services are accepted. |
| `PATCH /api/trips/:code/devices/:id` `{mute}` | Pause this phone alone (`null` or `{until}`). `GET` reads it; `DELETE` takes the phone off the trip. |
| `POST /api/trips/:code/devices/:id/test` | A test notification to this phone only. |
| `POST /api/trips/:code/simulate` `{type: "up" \| "down"}` | See above. |

Bad input is a 400 that says why, an oversized body a 413, and too many requests a 429 with `Retry-After`.

## Security

- **ntfy topics are the security model**: anyone with the topic name can read/write it. The random suffix makes it unguessable; treat trip links like a shared secret.
- **Rate limits** per client (the last `X-Forwarded-For` entry on Railway): new trips 20 then 20 an hour; test and simulated pushes 10 then 30 an hour, per client and per trip; unknown trip codes 30 then 60 an hour, after which even a right guess waits. Every push leaves from this one server, whose IP ntfy.sh rate-limits, so this keeps one abuser from throttling everyone's alerts. Limits live in memory and reset on restart.
- Every response carries a Content-Security-Policy (same-origin only, no inline scripts), `nosniff`, `no-referrer` and frame denial, plus HSTS over HTTPS.

## Troubleshooting

- **No alerts on one phone**: Trip tab → Alerts on this phone. Send a test; if it doesn't arrive, check that notifications are allowed for ntfy and that the topic you subscribed to matches exactly.
- **`sent: 0` from simulate or no alerts at all**: the trip is paused, the park is past its last close, or the ride's alerts are off (its switch on the Rides tab). Check `/api/health?token=…` to see whether the park is being polled at all.
- **Header says "Ride times may be out of date"**: the server hasn't had a good answer from ThemeParks.wiki for 3+ minutes; `/api/health?token=…` shows the last error. Alerts resume on their own when it answers again.
- **Estimates say "From typical theme park outages"**: fewer than 5 comparable past outages anywhere yet, so the built-in prior is in use. Set `THEMEPARKS_API_KEY` to backfill 30 days instead of 7.
- **A storm outage gets an ordinary estimate**: the weather reports are more than 75 minutes old (the feed is down; the server log says so), or the archive hasn't yet shown that ride closing for storms on two days.

## Notes & limits

- **HTTPS**: geolocation and PWA install require a secure context. Railway's `*.up.railway.app` domain is HTTPS out of the box; `localhost` also counts for local dev. GPS denied/unavailable degrades gracefully to the manual picker.
- **Adding parks**: append to `server/parks.js` with the park's timezone and the resort to list it under (entity IDs from `https://api.themeparks.wiki/v1/destinations`).
- Only transitions involving DOWN alert: down, back up, opened late, and closed while down. Other status changes (a ride opening on time, going to REFURBISHMENT) don't.
- Trips nobody has opened in three weeks stop being polled and stop getting alerts, which is most of what hosting costs. A trip with a phone signed up for alerts (the app's own notifications, or ntfy once a test arrived) keeps going for two months instead, since trips are often made months ahead, and its phones get `Ride alerts stop tomorrow` in the park's daytime the day before. Opening the app again resumes a trip. Trips are never deleted.
- Times are shown in the park's own time zone, so planning from home still reads like the park clock.
- Weather reports come from airports 5 to 20 miles from the parks. A storm can sit over the park and miss the airport, or the reverse; the 15-minute lead and the two stations per resort soften that, but it will sometimes be off.
- Estimates are only as good as the history behind them. The first week after a fresh deploy runs on 7 days (30 with a key), and the archive grows by a day each night from there.

Built by Austin Vodrazka with Claude.
