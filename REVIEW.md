# ParkAlert review 4: the stress lab

Date: 2026-09-29. `main` at `173226b` (after the stress lab, PR #9). Branch `qa-review`. Written before any app code changed; every finding was then fixed on the same branch (see [Resolution](#resolution)).

## Resolution

Every finding below was then fixed on this branch, one commit per group, each with tests, lint and a check in the stress lab. The review text is left as it was written; this table says where each finding went. `npm run check`: lint clean, **246 of 246 tests pass** (200 before).

| Finding | Commit | What changed |
|---|---|---|
| C1 | `6fb591f` | A page opened from an alert shows its skeleton until its own fresh detail is in; every ride page shows the newer of the dashboard and its detail; pushes carry the ride's new state, and the service worker tells an open app to patch it and refresh. Lab: the tapped page read "Down <1 min · since 7:14 PM" with advice, and the new card appeared as the push landed. |
| H1 | `d3ae9b8` | "Down" goes out at once; only "back up" waits, until the ride has stayed up a minute. No time cooldown. |
| H2 | `b24aa0a` | An outage's kind is settled the first poll it is seen and kept; a hold needs 5 rides within 3 minutes; a breakdown joins a hold only with lightning reported; one outlook per hold. |
| H3 | `0a9a334` | A hold (or 3+ rides in one poll) is one incident: one push down, then quiet "6 of 18 rides are back up" updates and a final "All 18 rides are back up". Lab: storm and clearing, 2 pushes where there were 14. |
| H4 | `0a9a334` | Incident pushes share a tag, so each update replaces the last; a ride back after an hour or more gets its own push. |
| H5 | `7d79f4b` | Each headliner against its own usual wait for the hour, at least half of them posting, 15-minute smoothing, a label that changes only when two readings agree, and "Crowd level paused" during a hold and 30 minutes after. Lab: a storm paused it; a surge moved it smoothly to "Much busier than usual". |
| H6 | `a474024` | Open or closed is judged by the posted hours and the rides together ("Most rides are closed", "Open past its posted hours"); the schedule is fetched again when they disagree. |
| H7 | `b04beaa` | At 200% text no tab scrolls sideways (375 of 375 px), the trip code always shows whole, margins stay 16 px. |
| H8 | `7d79f4b` | New trips follow the park's ten headliners; attractions that never post a wait are listed apart and never alert; suggestions rank by wait against each ride's usual. |
| H9 | `9479d89` | A wait alert is used up only when a phone could see it. |
| H10 | `bbfcb34` | A trip with phones signed up stays active 60 days after anyone opened it, and its phones hear the day before it stops. Asking for trip dates at setup was not built. |
| H11 | `a474024` | Rides running outside the posted hours keep alerts on and the app open. |
| M1 | `c86b78f`, `f53905e`, `7d79f4b` | Stale by data age only; "Ride feed not answering"; one push after 10 minutes of feed failure and a quiet one when it is back; the crowd row greys and says "as of". |
| M2 | `f53905e` | A fresh snapshot is answered at once even with a slow poll under way; pull to refresh reports the data's age. |
| M3 | `04011c1` | A joining phone's own sign-up finishes before the setup sheet is considered; "Done", not "Set up later", once set up. |
| M4 | `9501190` | "Often back in"; chances never read 0% or 100% (">95%", "Nearly all"); no scorecard share under 10 reopenings. |
| M5 | `9501190` | One rounded percentage for "closed for the day"; one phrase for "past nearly every outage"; no invented upper bound; a clock start that never moves earlier. |
| M6 | `9501190`, `7d79f4b` | The chance legend is labelled; the crowd level is a sentence, with no 1 to 10 scale to misread. |
| M7 | `9501190` | A very long outage says "Ride something else"; with no history anywhere, a built-in prior labelled as such. |
| M8 | `c86b78f`, `161ea9a` | "Down since before 9:11 AM" and "12 min+" for rides already down when first seen, and "went down between" after a gap, in pushes and the app. |
| M9 | `842e0fb` | A scrolled reader keeps their place; at the top a new card grows in. Lab: the card being read stayed at the same 147 px with zero layout shift. |
| M10 | `14efce5` | Weather every minute during a hold; "Storm passed at 3:12 PM" with the reopening times; the lab's reports carry begin and end remarks. Lab: pushed 57 s after the clearing, with the exact minute. |
| M11 | `0a9a334` | The storm push leads with the hold, the range and what to do, then the names. |
| M12 | `134d801` | A hold's returns are one row that opens in place; single returns stay half an hour. |
| M13 | `5be7f3c` | API JSON gzipped (30 KB to 4 KB); the loading skeleton and the right screen show before app.js arrives; no extra round trip on a tapped alert with nothing to lose. |
| M14 | `842e0fb` | Pages stop above the tab bar, which stays usable; the large title scrolls away and a compact bar takes over. |
| M15 | `91818bd` | The join field takes a code with spaces, an invite link or the whole invite message. |
| M16 | `3b66683` | Leaving says to unsubscribe in ntfy too, naming the topic. |
| M17 | `4d321af` | "Send a test alert" tests this phone; every phone is behind a confirm; the ntfy setup's test goes to ntfy only. |
| M18 | `aba979b` | Wait limits step down from the current (or usual) wait, up to 180; "Alert set for", not "You asked for". |
| M19 | `aba979b` | "Best time left today", from now to today's close. |
| M20 | `7da1fd3`, `042d663` | Cards are links described by their verdict and times; headings in order; contrast fixed (filter counts, tab labels); the meta line no longer re-announces each minute. axe-core: no violations on Down now, Rides or Trip. |
| M21 | `c86b78f` | A down ride that leaves the feed is kept 30 minutes; gone longer, "is no longer listed". |
| L1 to L4 | `55d2a37` | "Alerts" filter label; no break before AM/PM; plain separators; a right chevron. |
| L5 | `fa7d56f` | Search takes digits, short forms, plurals, initials and fan acronyms. |
| L6, L9, L10, L14, L24 | `87476ad` | Tabs tell each other about saves; a tap on a fading toast does nothing; the update offer never replaces Undo; the pause sheet redraws fresh; sharing falls back to copying; resume redraws everything. |
| L7, L21, L22 | `696bec7` | Breakdown-only typical and longest; outages that began today; a relative trend threshold. |
| L8 | `161ea9a` | "Late to open · noticed 8:19 AM"; "Opened at 8:23 AM" with no lateness claimed. |
| L11 | `7d79f4b` | The crowd row greys and says "as of" when old. |
| L12 | `bd48628` | 400 for broken escapes; 404 for wait alerts on unknown rides; pause times within a year; X-Forwarded-For trusted only behind a known proxy (`TRUST_PROXY`). |
| L13 | `7823a6c`, `042d663` | Location suggests a park to confirm; tighter geofences (Magic Kingdom 0.65 km leaves the Contemporary out). |
| L15 | `ef9bec6` | Times written the phone's way, in the app and (through the service worker) in its pushes. |
| L16 | `55d2a37`, `91818bd` | "6-character code"; "a ride with alerts on" everywhere. |
| L17 | `2f6b121` | The install sheet leads with "Needed for alerts on iPhone" and names the trip. |
| L18 | `105fc89` | A new weather report rebuilds only its parks' models, off the request path (a dashboard after a report: 194 ms to 2 ms in the year benchmark). |
| L19 | `a4b8282` | One pause list under This phone / Everyone, with "Until the park closes". |
| L20 | `134d801` | Rides in a hold: this trip's first, then A to Z. |
| L23 | `7d79f4b` | Lines building is limited per trip, after a push reached a phone. |
| L25 | `919c38b`, `14efce5` | Honest lab docs; a 12 s slow feed; phone pushes, links and line breaks in the panel; `--keep` keeps the world; `--auto` reopens what it closes; storms shared by stations. |
| P1, P5 | `84ab9b5` | The icon set's check; a wait chart of the last six hours, scaled to them. |
| P2 | `84ab9b5`, `d8745d9` | Two columns of cards on iPad from 768 px. A list and detail side by side was not built. |
| P3 | `aba979b` | "Alert me when the wait is at or under". |
| P4 | `55d2a37` | "No ride alerts". |
| P6 | `b04beaa` | A wrapping button keeps its icon above the words. |
| P7 | `9501190` | Hollow legend keys for shares under 5%. |
| P8 | `134d801` | A hold is a "Storm hold" with a bolt only when the weather says so; otherwise "18 rides paused at once" with a pause icon. |
| S1, S7 | `2f6b121` | A per-trip manifest (`start_url=/?trip=CODE`) and the address carrying the trip while the install sheet is open; a Home Screen app with no trip asks for the code; both Safari layouts in the steps. Needs a real iPhone to confirm. |
| S2, S8 | `5e1d9c4` | The badge count travels in each push and the service worker sets it; "down" and "closed" go out urgent. |
| S3 | `737d6ad` | A monochrome transparent badge for Android's status bar. Needs an Android phone to confirm. |
| S4 | `3e27dfc` | The service worker re-subscribes on `pushsubscriptionchange` and sends it with a new `PUT` device endpoint. Needs a rotating push service to confirm. |
| S5 | `7d79f4b` | Covered by H5's fix: readings from before a hold are dropped and the level pauses 30 minutes after. |
| S6 | `d3ae9b8`, `0a9a334`, `7d79f4b` | Volume is down through H1, H3 and H8 (headliners by default). Production's own outage counts were not measured: that needs its data. |
| Words | `55d2a37` and the groups above | Every row of the words table: "Check back in about 20 min", "Stay close", holds named for what is known, the lightning rule spelled out, no "just", long outages named, one "Often back" phrasing, the ntfy wording, "Done", "One moment…". |

Not acted on, as they are product calls rather than defects: the three product ideas, "What's missing", and "What to cut" (the trip-wide test row did go, in M17; the scorecard and "Most outages" were left where they are).


## Verdict

The plumbing is solid: saves, Undo, Back, the service worker update, offline start, validation and rate limits all held up under abuse. The product on top of it is not ready for a stressed guest in a storm. The three moments that matter most are wrong or noisy:

1. **Tapping an alert** with the app open shows the opposite of what the alert said.
2. **A storm** buzzes the phone a dozen times as rides reopen. The lock screen keeps saying "18 rides just went down" after they are back, and a second storm within 5 minutes is announced 5 minutes late.
3. **Crowd levels and "park-wide hold"** react to ride outages as if they were crowds and storms. The advice then flips under the guest's feet.

Alerts can also go silent without a word: a trip set up more than three weeks ahead stops alerting; a paused phone loses its wait alerts for good; and when the posted hours say "closed" while rides run, every alert is muted. Accessibility at large text sizes breaks the Rides and Trip tabs. Most of the remaining findings are about honesty: numbers that disagree on the same card, 50% ranges called "usually", 100% chances from ten samples, and "Everything's running" when nothing is.

## How this was tested

- `npm ci`, then `npm run check`: lint is clean and **200 of 200 tests pass**.
- `npm run lab` ran from 07:53 to about 10:00. It was restarted once, from a copy with one changed comment in `app.js`, to act as a deploy. The polling interval was 10 seconds.
- **The app's own notifications were captured, never sent.** A small fake push service ran on `127.0.0.1:4200`, allowed through the server's existing `PUSH_TEST_ORIGIN` hook. Every native push was decrypted (RFC 8291) and logged next to the ntfy pushes the lab panel captures. A recorder kept both in one timeline, which is where every push count below comes from.
- **Devices:** headless Chrome driven over the DevTools protocol (Playwright), the same engine features as DevTools device mode: mobile viewport, touch events, and iPhone, Android and iPad user agents. Sizes were 375×812, 393×852, 430×932, iPad 820×1180 and landscape 852×393.
  - An iPhone "Home Screen app" was emulated with `navigator.standalone = true`.
  - Gestures were real touch sequences with 60 Hz timestamps.
- **Settings:** light and dark mode, 200% text (default font size 32 px through `Page.setFontSizes`, which is how the browser's own text size reaches this rem layout), and reduced motion.
- **Networks:** slow 3G (2 s round trip, 50 KB/s) and offline, as DevTools emulates them.
- **Scenarios:** every button alone at Magic Kingdom (storm also at EPCOT). Then the combinations:
  - storm during a wave;
  - flapping ride during a crowd surge;
  - the feed dying mid-storm;
  - breakdown then park closing;
  - chaos twice, 90 seconds apart;
  - then 20 minutes emulating `npm run lab -- --auto`: a random scenario every 90 s across the three lab parks, with the same exclusions as the lab.
- **Flows:** every flow in the brief, on four phones at once on trip `MKLABS` and three more trips.
- **Data growth:** a year of synthetic archive for all six parks (25 outages per park per day), with the hot paths timed against it.
- **Automated accessibility:** axe-core on every tab, sheet and page.
- **Safety:**
  - No railway command was run. The live site and real ntfy topics were not touched.
  - The only outside traffic was the lab's own read-only fetch of the real ride rosters from `api.themeparks.wiki` at start-up (see L25).
  - No real iPhone was used. Anything that needs one is under [Suspected](#suspected-not-reproduced).
- **Screenshots** cited below are in [`review-4/`](review-4/).

### Labels

- **Severity**
  - **Critical:** a guest is told the opposite of reality, or misses an alert, in a common situation.
  - **High:** a core job misleads or fails in a realistic scenario, or an accessibility blocker.
  - **Medium:** clearly wrong, confusing or un-native.
  - **Low:** a rough edge.
  - **Polish:** craft.
- **Evidence**
  - **Reproduced:** seen in the running app.
  - **Code:** follows from the code, and where possible was confirmed by calling the server's own functions. Not triggered in the app.
  - **Suspected:** listed separately and not counted as fact.

## Summary

| ID | Sev | Evidence | Finding |
|---|---|---|---|
| C1 | Critical | Reproduced | Tapping a "down" alert with the app open shows the ride as open, with a wait and a wait-alert offer |
| H1 | High | Reproduced | The anti-flicker cooldown holds real "down" alerts up to 5 minutes, so phones say "back up" while rides are down |
| H2 | High | Reproduced | Unrelated breakdowns are relabelled a "park-wide hold", flipping advice already given |
| H3 | High | Reproduced | A storm's reopening is a stream of buzzes: 13 pushes in 5 minutes |
| H4 | High | Reproduced | The lock screen keeps "18 rides just went down" forever and one grouped "back up" erases another |
| H5 | High | Reproduced | The crowd level measures outages, not crowds, and jitters minute to minute |
| H6 | High | Reproduced | "Everything's running", "Open until 1:53 PM" and "Alerts on" with all 40 rides closed |
| H7 | High | Reproduced | At 200% text the Rides tab scrolls sideways (614 px on a 375 px screen) and the trip code is cut to "MKLA" |
| H8 | High | Reproduced | Every attraction alerts by default, including a castle, a splash pad, galleries and an aquarium |
| H9 | High | Reproduced | A per-phone pause silently uses up wait alerts |
| H10 | High | Reproduced | A trip created more than three weeks ahead goes silent on the day, with no warning |
| H11 | High | Reproduced | When the posted hours say closed but rides are running, alerts are muted and the app says "Park closed" |
| M1 | Medium | Reproduced | A ride-feed outage is blamed on ParkAlert, reported after one failed poll, and shown as "Everything's running" |
| M2 | Medium | Reproduced | Slow feed: every refresh waits 5 s, then pull to refresh says "Updated just now" over stale data |
| M3 | Medium | Reproduced | A second phone's setup sheet says "Turn on notifications" while the header says "Alerts on" |
| M4 | Medium | Reproduced | "Usually" and "Likely" describe a coin flip; 100% and 0% chances from about ten outages; "0% in range" after one |
| M5 | Medium | Code | One card, contradictory numbers (25% and "3 in 10"; "most" and "nearly every"; "about 20 min" and a 20 to 40 min clock window) |
| M6 | Medium | Reproduced | The chance numbers and the crowd scale are never explained on screen |
| M7 | Medium | Reproduced | "Running long" and "Not enough history" are verdicts that give no advice |
| M8 | Medium | Reproduced | After a restart or polling gap, a ride down for an hour shows "Down <1 min" with fresh-outage advice |
| M9 | Medium | Reproduced | Down now jumps when cards, a hold or the crowd row appear (layout shift up to 0.62) |
| M10 | Medium | Reproduced | Weather lags 5 minutes: "Lightning still nearby" while rides reopen, and the storm's end time is late |
| M11 | Medium | Reproduced | The storm push leads with 18 ride names; the hold and the range are cut off on a lock screen |
| M12 | Medium | Reproduced | "Back up recently" grows to 20 rows after a storm and stays for two hours |
| M13 | Medium | Reproduced | API responses are not compressed (30.6 KB per refresh vs 3.9 KB); first visit on slow 3G takes 10.4 s |
| M14 | Medium | Reproduced | Detail pages cover the tab bar, and the large title never collapses |
| M15 | Medium | Reproduced | The join field can't take a pasted code or invite text |
| M16 | Medium | Reproduced | Leaving a trip leaves ntfy phones subscribed, with no word about it |
| M17 | Medium | Reproduced | "Send a test" on the Trip tab and in ntfy setup buzzes every phone on the trip |
| M18 | Medium | Code | Wait alerts stop at 60 minutes, below every headliner's typical wait |
| M19 | Medium | Reproduced | "Best time to ride" names hours that are already over or outside today's hours |
| M20 | Medium | Reproduced | VoiceOver hears only the ride name on a down card; the verdict and times are hidden |
| M21 | Medium | Code | A ride that drops out of the feed while down, then comes back, never gets its "back up" |
| L1 to L25 | Low | Mixed | See [Low](#low) |
| P1 to P8 | Polish | Mixed | See [Polish](#polish) |
| S1 to S8 | Suspected | Suspected | See [Suspected](#suspected-not-reproduced); S1 would be Critical if confirmed |

---

## Critical

### C1. Tapping a "down" alert with the app open shows the ride as open, with a wait and a wait-alert offer. Reproduced

- **Lab:**
  1. Trip `MKLABS`, phone at 393 px with the app's own notifications on, on Down now.
  2. Panel: `breakdown`.
  3. When the push arrives (about 4 s later), tap it while the app is in the foreground. The service worker then focuses the window and posts `{type: 'open', url}` (`sw.js:70-84`); the test sent the same message.
- **What happened** ([screenshot](review-4/10-tap-alert-app-open-393.jpg)):
  - The push said "Trick-or-Treat Locations at Mickey's Not-So-Scary Halloween Party is down".
  - The ride page opened with **"Open · 75 min wait"** and the wait-alert block "Now 75 min. Tell me when the wait is at most (minutes): 10 15 20 30 45 60".
  - The chart on the same page said **"Now · not running"**.
  - It stayed wrong until the next 30-second refresh. Down now likewise didn't show the new card until 20 s after the push.
- **Why:**
  - `openPending` opens the ride from the last dashboard, up to 30 s old.
  - `rideHtml` (`app.js:2022-2024`) takes the status from that stale `liveRide` even though `page.load()` has just fetched fresh detail.
  - Nothing refreshes the dashboard when a push lands or is tapped.
  - On iPhone a banner tapped while the Home Screen app is already in front changes no visibility, so no refresh happens at all.
- **Should:** the screen an alert opens must agree with the alert: "Down <1 min · since 9:58 AM" and a verdict. If fresher data is still on its way, show a skeleton instead of stale data.
- **Fix:**
  1. On the `open` message, and on boot with `?ride=`, `await refresh()` before `openRide`, with the ride's skeleton showing.
  2. In `rideHtml`, use `detail.ride` whenever `detail.now > dash.now`.
  3. In `sw.js` `push`, `postMessage({type: 'refresh'})` to every window client, so an open app updates as the push arrives.
  4. Put `status` and `downSince` in the push data and patch them into the page at once.

---

## High

### H1. The anti-flicker cooldown holds real "down" alerts up to 5 minutes, so phones say "back up" while rides are down. Reproduced

- **Lab:** `chaos`. Wait for the rides to come back, then `recover`: "21 rides are back up" is pushed at 8:45:02. At 8:45:37 run `storm`, and 25 s later `outage`.
- **What happened:**
  - The server logged `cooldown: holding DOWN` for all 20 storm rides, because they had last been announced down at 8:41, and sent nothing.
  - With the feed failing, the held alerts waited for the feed to come back. At 8:50:02 came "19 rides just went down … Storm passed at 8:48 AM. By the 30-minute rule, back in 30 to 45 min": 4.5 minutes after the rides closed and 2 minutes after the storm had passed.
  - Ten seconds later, "Tiana's Bayou Adventure is back up".
  - From 8:45 to 8:50 every phone's latest word was "21 rides are back up".
- **The same bug, other forms:**
  - Without the feed outage the delay is still up to 5 minutes. Any ride that breaks again within 5 minutes of reopening is announced late.
  - The cooldown also delays "back up". One `recover` at 9:16:22, every ride reopening in a single poll, arrived as five pushes over a minute. The server logged `cooldown: holding UP` for 20 rides; out came "9 rides are back up", three singles, then "18 rides are back up" at 9:17:24.
  - In `chaos`, Peter Pan's Flight was held out of the storm's grouped push. A minute later it went alone as "Peter Pan's Flight is down · Park-wide hold: 24 rides closed at once · … Ride something else", which reads like a second storm.
- **Should:** a ride going down is the alert that matters; it must never wait behind the one before it. What deserves suppressing is a brief "back up".
- **Fix** (`gateEvents` and `NOTIFY_COOLDOWN_MS`, `poller.js:160-204`): replace the per-direction time cooldown with a state debounce.
  - Send DOWN at once unless the last alert sent for that ride was DOWN.
  - Send UP only after the ride has stayed up for two polls. If it goes down again inside that window, send nothing: the phone's last word ("is down") is still true.
  - Fold anything held into the current poll's group, never into a solo push.
  - After a feed outage, drop held "went down" events for rides that are no longer down.

### H2. Unrelated breakdowns are relabelled a "park-wide hold", flipping advice already given. Reproduced

- **Lab:** at Magic Kingdom, `breakdown` (7:57), `breakdown` (7:58), then `wave` (7:59).
- **What happened** ([screenshot](review-4/11-hold-card-393.jpg)):
  - Before the wave, the two breakdowns had separate cards: "Check back soon. 76% of outages like this are over within 30 min. Likely back 8:05 AM to 8:27 AM".
  - After it, one card read "**Park-wide hold · 5 rides** … **Ride something else**. Only 38% of outages like this are over within the hour … Usually back in 50 min to 1 hr 10 min". It carried a lightning bolt and "Since 7:57 AM".
  - The wave's push: "3 rides just went down … **Park-wide hold at Magic Kingdom** · Usually back in 50 min to 1 hr 10 min".
  - Cinderella Castle, one of the "5 rides", reopened 30 seconds later.
- **The same absorption happens in every storm:**
  - A breakdown 2 minutes before the 8:06 storm became the hold's "Since 8:04 AM".
  - Because the hold card takes its outlook from its earliest ride, the card said "Ride something nearby" while the rides inside it said "Ride something else".
- **Why:** `clusterLive` (`predict.js:121-135`) treats any 5 down rides whose outages began within 10 minutes of each other as a hold (`CLUSTER_WINDOW_MS`, `episodes.js:21-22`). `rememberHolds` (`poller.js:94-103`) then makes the label stick for the rest of each outage.
- **Should:**
  - A hold is a near-simultaneous closure; lightning closed 11 rides inside two minutes in the archive the README cites.
  - A ride already announced as a breakdown keeps its own estimate unless the weather says otherwise.
  - The hold card has one start time and one verdict.
- **Fix:**
  - Cluster on a 2 to 3 minute window, counted around the median start, not chained across 10 minutes.
  - Don't reclassify a ride whose DOWN alert has gone out unless a storm is reported.
  - Take the card's "Since" from the cluster's median start and one outlook for all its rides.
  - Change `classify` in `episodes.js` the same way, so the history and live rules stay one rule.

### H3. A storm's reopening is a stream of buzzes. Reproduced

- **Lab:** `storm`; about 2 minutes later, `clear`.
- **What happened:**
  - One grouped "18 rides just went down" for the closing, which is good.
  - Then **13 separate pushes in 5 minutes** as the hold's rides reopened (8:09:31 to 8:14:31): 9 single "X is back up" and 4 "3 rides are back up". Singles arrived every 10 to 20 s, and two landed in the same second ungrouped.
  - Across the session, trip `MKLABS` received **72 pushes in 75 minutes**. 43 were single "is back up". The busiest 10 minutes held 17.
  - A ride flapping inside the storm added "Walt Disney's Enchanted Tiki Room is down · Park-wide hold: 26 rides closed at once · … Ride something else" and, 20 s later, "… is back up · Was down <1 min". This happened in both `chaos` runs.
- **Why:** grouping happens only inside one poll (`GROUP_MIN`, `poller.js:286`, `397-418`), and reopenings after a hold are spread over minutes. The README's "a storm hold is one buzz rather than eleven" holds only for the closing.
- **Should:** one storm, one conversation: "Storm hold: 18 rides closed", then quiet updates, then "All 18 back".
- **Fix:**
  - Make a hold an incident with an id.
  - While it is open, batch its rides' UP events over 2 to 3 minutes and send "6 of 18 back up" with the incident's tag, so each update replaces the last. Close with "All back".
  - List the rides the phone follows first.
  - Never send a single-ride "is down" for a ride that joins a hold already announced.

### H4. The lock screen keeps "18 rides just went down" forever and one grouped "back up" erases another. Reproduced

- **Evidence:** the 15 native pushes phone A received during the 8:06 storm, replayed with standard `Notification.tag` replacement.
- **What happened:**
  - The phone would be left with **12 notifications**.
  - "18 rides just went down" (tag `down:group`) is never replaced, because each ride's "back up" uses its own `ride:<id>` tag.
  - Every grouped "back up" shares the tag `up:group`, so each one replaced the last. "Seven Dwarfs Mine Train, Peter Pan's Flight, Country Bear Musical Jamboree … Down 6 min to 5 hr 20 min" disappeared when the next group arrived 30 s later.
  - The notification lost was the one a family had waited all morning for: Peter Pan's Flight back after 5 hours 20 minutes.
- **Should:** a storm's "down" notification is replaced by its own resolution; one group never erases another; a long-awaited ride is named.
- **Fix:**
  - Tag grouped pushes with the incident id (`hold:<start>`), so the "back up" summary replaces the "went down" one.
  - Give independent groups distinct tags.
  - When a ride returns after more than an hour, send it in its own push: "Peter Pan's Flight is back up after 5 hr 20 min".

### H5. The crowd level measures outages, not crowds, and jitters minute to minute. Reproduced

- **Lab:** watch the crowd row through `breakdown`, `storm` at Magic Kingdom, and `storm` at EPCOT (panel Park: EPCOT).
- **What happened:**
  - One headliner going down took Magic Kingdom from 4/10 "About usual" to 3/10 "Quieter than usual" (index 75 to 70).
  - During the Magic Kingdom storm the row **vanished**, because fewer than 3 headliners were posting. The list jumped up under the reader.
  - A new trip opened mid-storm read **"Quieter than usual · 2/10"** with 25 rides closed.
  - At EPCOT the storm alone moved the level from 4/10 to 6/10.
  - With no scenario running, the level moved between 4, 5 and 6 from one refresh to the next.
- **Why:** `crowdIndex` (`crowds.js:96-99`) averages whichever headliners are posting, so the set shrinks as rides close. It is then ranked against past days on which all ten posted (`crowdstate.js:33-39`). Nothing smooths it.
- **Should:** the level moves when the crowd moves. A storm never reads as a quiet park.
- **Fix:**
  - Score each headliner against its own typical wait for this hour (a ratio), and average the ratios of those posting.
  - Require at least 5 of the 10.
  - Smooth over 15 minutes and change the label only after two readings agree.
  - During a hold, show "Storm hold: crowd level paused" rather than a number.
  - The lines-building alert reads the same index, so it inherits the fix.

### H6. "Everything's running", "Open until 1:53 PM" and "Alerts on" with all 40 rides closed. Reproduced

- **Lab:** `breakdown`, then `closing` (the park closes in 2 minutes; every ride is CLOSED by 8:39).
- **What happened** ([screenshot](review-4/28-after-closing-393.jpg)):
  - With 40 of 40 rides CLOSED, the header still said "Open until 1:53 PM", the pill "Alerts on", and Down now "**Everything's running.** You'll get an alert when a ride with alerts on goes down."
  - The down ride got a "Peter Pan's Flight has closed … It may not reopen today" push, and auto-mute never engaged.
  - In auto mode the same combination at larger scale: `storm` at 9:37, then `closing` at 9:43. At 9:45 every phone got "**24 rides have closed** … They may not reopen today", a push the server suppresses at a scheduled close but not at one it hasn't heard about.
- **Why, server:** the server keeps the schedule fetched at 7:53 for an hour (`SCHEDULE_TTL_MS`, `poller.js:482-492`), so an early close goes unnoticed. The lab's `closing` button therefore can't demonstrate auto-mute at all (see L25).
- **Why, client:** the empty state is chosen only from the absence of DOWN rides (`downHtml`, `app.js:1199-1208`). Any time rides are CLOSED mid-day, it says "Everything's running".
- **Should:**
  - Say "Most rides are closed right now" and stop promising alerts.
  - "Everything's running" only when rides actually are.
- **Fix:**
  - Count OPERATING and CLOSED rides for the empty state.
  - On the server, when 80% or more of rides turn CLOSED in one poll, refetch the schedule at once and treat it as a closing for `isPastClosing` and `closingIsNews`.

### H7. At 200% text the Rides tab scrolls sideways (614 px on a 375 px screen) and the trip code is cut to "MKLA". Reproduced

- **Lab:** 375×812, text at 200%, trip `MKLABS`; open Rides, then Trip ([Down now](review-4/36-200pct-down-375.jpg), [Rides](review-4/37-200pct-rides-375.jpg), [Trip](review-4/38-200pct-trip-375.jpg)).
- **What happened:**
  - The search field keeps a text input's intrinsic width, about 20 characters at 32 px. The search row overflows and the layout viewport grows to **614 px**: the page pans sideways and the sort button sits off-screen.
  - On Trip, the code reads "M K L A"; "B S" is clipped. That is the one thing a guest reads aloud to family.
  - Gutters and card padding are in rem, so they double too, leaving about 60% of the width for text. The crowd row wraps as "Big rides / average 79 min, / usually 78 at 8 / AM".
- **Should:** no horizontal scroll at any text size; the trip code always fully visible; margins stay phone-sized, as iOS keeps them at accessibility sizes.
- **Fix:**
  - `.search-row .search { min-width: 0 }` and `.search input { width: 100% }` (`style.css:640`, `272`). Move the sort button under the search field when `.ax-type` is set.
  - `.trip-code { font-size: min(2.25rem, 12vw); letter-spacing: 0.12em }`.
  - Under `.ax-type`, keep `--gutter` and card padding at 16 px.

### H8. Every attraction alerts by default, including a castle, a splash pad, galleries and an aquarium. Reproduced

- **What happened:**
  - The real Magic Kingdom roster, fetched by the lab, has 36 attractions. All start with alerts on, and every outage costs two pushes. They include:
    - Cinderella Castle;
    - "Trick-or-Treat Locations at Mickey's Not-So-Scary Halloween Party";
    - Main Street Vehicles;
    - Casey Jr. Splash 'N' Soak Station;
    - "A Pirate's Adventure ~ Treasures of the Seven Seas";
    - both railroad stations.
  - EPCOT's storm push began "ImageWorks - The "What If" Labs, Mexico Folk Art Gallery, Soarin' Across America, Guardians of the Galaxy: Cosmic Rewind, SeaBase Aquarium and 14 more".
  - The same filler reaches the suggestions. "Shortest waits right now" listed the splash pad and a railroad station. The lines-building push said "Shortest now: Astro Orbiter (15 min), Casey Jr. Splash 'N' Soak Station (15 min)".
  - At EPCOT it said "Shortest now: Project Tomorrow: Inventing the Wonders of the Future (10 min), Turtle Talk With Crush (10 min)": a post-show exhibit and a show. A 3-ride wave there led with "Advanced Training Lab", a play area.
- **Should:** a first-time guest hears about rides they'd plausibly ride; the rest is opt-in; non-rides never alert.
- **Fix:**
  - Default the follow list to the park's headliners, which `crowds.js` already computes.
  - Hide attractions that never post a wait in the archive from the alert list.
  - In suggestions, rank by wait against the ride's usual, not by the raw wait.
  - See product idea 1.

### H9. A per-phone pause silently uses up wait alerts. Reproduced

- **Lab:**
  1. Trip `TMMDT5` with one phone on the app's own notifications.
  2. Pause that phone for an hour.
  3. Set a wait alert. The API's maximum of 240 was used to make it fire on the next poll; the UI's 10 to 60 takes the same path.
  4. Wait one poll, then unpause.
- **What happened:**
  - The alert went to the trip's ntfy topic, which no phone subscribed to, and was stored as sent at 8:04 with a 75-minute wait.
  - The paused phone received nothing, before or after unpausing.
  - The ride page now says "Sent at 8:04 AM, when the wait was 75 min."
- **Why:**
  - `deliver()` (`deliver.js:17-35`) reports success when the ntfy publish succeeds. ntfy.sh accepts a publish whether anyone is subscribed or not.
  - `notifyWaitAlerts` (`poller.js:431-449`) then marks the alert sent.
  - Per-phone pauses live only inside `deliver`.
- **Should:** the README's promise, "a pause or the park's close holds it rather than using it up", holds for a phone pause too.
- **Fix:**
  - Count a wait alert as sent only if an unpaused phone received it, or if the trip has an ntfy phone confirmed working. Record the confirmation on the server when "It arrived" is tapped, not only in `localStorage`.
  - Otherwise keep it armed. The same return value decides `sent` for tests and `simulate`.


### H10. A trip created more than three weeks ahead goes silent on the day, with no warning. Reproduced

- **Lab:** a second server on port 3100 against the lab's feed, with two trips at Magic Kingdom, each with one phone on the app's own notifications. `IDLE22` was last opened 22 days ago; `SEEN01` yesterday. Then `breakdown`.
- **What happened:** the `SEEN01` phone got "Haunted Mansion is down"; the `IDLE22` phone got nothing, and no error is visible anywhere.
- **How it happens:**
  - A trip nobody has opened for 21 days is dropped from polling and from every push (`TRIP_IDLE_MS` and `isTripActive`, `store.js:210-218`; `notifyTrips` and `activeParkIds`).
  - "Opened" means a dashboard load (`touchTrip`, `index.js:126`).
  - Disney trips are planned months out. A family that creates the trip at home, turns alerts on, and on the day leaves the phone in a pocket waiting for pushes gets nothing: no polling, no alerts, no error.
  - Nothing in the app mentions the rule. It is in the README only.
- **Should:** a trip with phones signed up for alerts keeps working on the park days it was made for, or tells its phones before it stops.
- **Fix:**
  - Count a push that reached a phone as activity, or keep a trip active while it has devices that registered in the last 60 days.
  - One day before a trip goes idle, push "Open ParkAlert to keep alerts on".
  - Better still, ask for the trip dates at setup and poll exactly those days.


### H11. When the posted hours say closed but rides are running, alerts are muted and the app says "Park closed". Reproduced

- **Lab:**
  1. `closing` at Magic Kingdom. Wait for the server's next hourly read of the hours, which now say 9:45.
  2. `recover` (or `reopen`): all 40 rides are running again with six more hours to go.
  3. `breakdown`.
- **What happened:**
  - Every phone showed "Closed for the day" and "Park closed. Closed for the day. Alerts start again when it opens." over a park with 40 rides running.
  - Mickey's PhilharMagic went down at 9:55 and nobody was told, on ntfy or on either phone.
- **Why:** muting trusts the posted hours alone (`isPastClosing`, `poller.js:139-151`). The server re-reads them hourly, or every 15 minutes near the close (`scheduleIsFresh`, `poller.js:484-492`). Nothing checks them against the rides it polls every minute.
- **In the park:** same-day hour extensions, and any hours the feed lists late or under another type, leave a family riding with alerts silently off. The app is telling them the park is closed.
- **Should:** when more than a few rides are OPERATING after the posted close, the park is open. Keep alerting, show "Open past posted hours", and re-read the hours at once.
- **Fix:** in `isPastClosing` and `alertState`, require the live ride statuses to agree, for example at least 80% of rides CLOSED, before muting. Re-read the schedule whenever the two disagree. This is the mirror of H6.

---

## Medium

### M1. A ride-feed outage is blamed on ParkAlert, reported after one failed poll, and shown as "Everything's running". Reproduced

- **Lab:** `outage` (the ride feed returns 503 for 4 minutes).
- **What happened:**
  - 16 s after the first failed poll the header said "Ride times may be out of date · <1 min old". The README promises 3 minutes; `app.js:1038` flags any `lastError`.
  - For the first 3 minutes Down now kept saying "Everything's running. You'll get an alert when a ride with alerts on goes down", while no alert could be detected.
  - It then said "Nothing was down as of 8:28 AM. This catches up as soon as **ParkAlert** can be reached again". ParkAlert was answering; the park's feed was not.
  - The crowd row stayed up with no hint it was old.
  - In auto mode, a `wave` at EPCOT landed inside an `outage` (9:41:44). It was pushed as "3 rides just went down" at 9:44:14, when the feed came back. "Gran Fiesta Tour Starring The Three Caballeros is back up · Was down 1 min" followed; the ride had been down 3 minutes. After a feed gap the "just" is false and the outage length is short by the gap.
- **Should:** "The park's ride feed isn't answering, so alerts are paused until it's back. Last update 8:28 AM." Warn after 3 minutes, as documented.
- **Fix:**
  - Drop `|| !!dash.lastError` from the stale test.
  - Add a `feed` failure kind whose copy names the feed.
  - Give the crowd row an "as of" when data is old.
  - After 10 minutes of feed failure, send one push to trips with phones.

### M2. Slow feed: every refresh waits 5 s, then pull to refresh says "Updated just now" over stale data. Reproduced

- **Lab:** `slow` (the feed takes 25 s to answer, for 3 minutes).
- **What happened:**
  - `/api/trips/MKLABS/dashboard` took 5,006 to 5,010 ms on 10 of 12 requests, against 2 ms before.
  - Pull to refresh spun for about 5 s, then flashed "**Updated just now**" while the ride data was over 2 minutes old.
- **Why:**
  - `freshPark` (`poller.js:541-548`) waits up to 5 s for any poll in flight, even when the snapshot is fresh. With a 20 s upstream timeout, one is nearly always in flight.
  - The flash (`app.js:2628-2632`) reports that the HTTP call worked, not how old the ride data is.
- **Fix:**
  - Wait on an in-flight poll only when there is no snapshot, or it is older than `FRESH_MS`.
  - Base the flash on `lastPoll`: "Ride times from 2 min ago. The park's feed is slow."

### M3. A second phone's setup sheet says "Turn on notifications" while the header says "Alerts on". Reproduced

- **Lab:** a phone that already allows notifications joins `MKLABS`: by code at 393 px, and by invite link on the emulated iPhone Home Screen app ([by code](review-4/07-joined-by-code-393.jpg), [by invite, dark](review-4/09-invite-link-iphone-dark-430.jpg)).
- **What happened:**
  - The phone registered itself: device id saved, trip shows 1 phone, pill "Alerts on".
  - The setup sheet that opened over it still said "ParkAlert can notify this phone itself. One tap, nothing else to install. [Turn on notifications] … Set up later".
- **Why:** `showApp` (`app.js:2766-2779`) calls `syncPhone()` without waiting, then opens the sheet at once; the sheet is never redrawn.
- **Fix:** `await syncPhone()` before deciding to open the sheet. If the phone is registered, show a toast ("Alerts are on for this phone") and send its test instead.

### M4. "Usually" and "Likely" describe a coin flip; 100% and 0% chances from about ten outages; "0% in range" after one. Reproduced

- **What happened:**
  - "Usually back in 8 to 30 min" and "Likely back 8:05 AM to 8:27 AM" are the 25th to 75th percentile, so half of reopenings fall outside. The park page's own footnote admits it: "about half should land inside".
  - The Walt Disney World Railroad card said "30 min 100% · 1 hr 100%" from 10 outages.
  - A late opening said "1 hr 100%" from 11.
  - Hold cards said "15 min 0% · 30 min 0%".
  - After a single scored outage, the park page showed "Breakdowns and other outages · 1 outage · **0% in range**".
- **Should:** words that match the odds, and no certainties from small samples.
- **Fix:**
  - Say "Often back in", or show an 80% range ("Most reopen within 5 to 45 min").
  - Cap displayed chances at 95% and floor them at 5% below 20 samples ("rarely", "almost always").
  - Hide scorecard rows with fewer than 10 outages ("Not enough reopenings yet").

### M5. One card, contradictory numbers. Code

Confirmed by calling `estimate`, `describe` and `advise` directly.

- **25% against "3 in 10":** with 25% of comparable outages closed for the day, the range text says "About 25% stay closed for the day" and the verdict detail says "3 in 10 outages like this didn't reopen that day". `Math.round(2.5)` is 3, `predict.js:270`. The ride page shows both.
- **"most" against "nearly every":** a long outage shows "Down longer than most outages here" (`describe`) and "Down longer than nearly every past outage like it" (`advise`). The explainer then repeats it a third way.
- **"about 20 min" against 20 to 40 min:** when the quartiles round to one value, the text says "Usually back in about 20 min". The card's clock line and bar invent an upper bound of twice that, "Likely back 9:35 AM to 9:55 AM" (`w.lo * 2`, `app.js:1089`, `1146`, `2030`).
- **The window moves backwards:** a late-opening card went from "Likely back 8:40 AM to 8:55 AM" at 8:20 to "8:38 AM to 8:58 AM" at 8:23.
- **Fix:** one source of numbers per card:
  - Take the "N in 10" from the same rounded percentage.
  - One phrase for "past nearly every outage".
  - No invented upper bound.
  - Never move a lower clock bound earlier than one already shown for the same outage.

### M6. The chance numbers and the crowd scale are never explained on screen. Reproduced

- **Chances:** the label "Chance it's back:" is visually hidden (`.vh`, `app.js:1133`). A sighted guest sees "■ 15 min 51% ■ 30 min 76% ■ 1 hr 87%" with nothing saying what the numbers are.
- **Crowd scale:** "About usual · 6/10" never says that the scale ranks this hour against the last 30 days. Many guests read 6/10 as "fairly busy", and crowd calendars use 1 to 10 as an absolute scale.
- **Fix:**
  - Show the label ("Chance it's back within").
  - Replace "6/10" with its meaning ("Busier than 5 of the last 10 days at 8 AM"), or explain it once on the park page.

### M7. "Running long" and "Not enough history" are verdicts that give no advice. Reproduced

- **What happened:**
  - Peter Pan's Flight, down 5 hours, said "Running long. Down longer than nearly every past outage like it." That is an observation, not what to do.
  - On a fresh server, the ride page's biggest text was "Not enough history to estimate yet" ([screenshot](review-4/51-no-history-ride-393.jpg)).
- **Should:** every down ride says what to do. The README promises exactly that.
- **Fix:**
  - "Running long" becomes "Ride something else. Outages this long rarely end soon."
  - With no history, fall back to a prior (all parks, or a built-in one from the archive the README describes), labelled as such.

### M8. After a restart or polling gap, a ride down for an hour shows "Down <1 min" with fresh-outage advice. Reproduced

- **Lab:** a second server started with an empty data folder against the lab's feed during a storm.
- **What happened:**
  - Every ride already down read "Down <1 min · since 9:11 AM"; the storm began at 9:06.
  - The hold said "Since 9:11 AM · <1 min", and "Outages today: 0" with 21 down.
  - The same happens after any gap over 15 minutes (`isBaseline`, `poller.js:555-556`). A ride down for 3 hours gets the estimate for one that just broke.
- **Fix:**
  - Mark baseline outages as "at least". Keep `downSinceKnown: false` and show "Down since before 9:11 AM".
  - Estimate with the censored elapsed, or say nothing.

### M9. Down now jumps when cards, a hold or the crowd row appear. Reproduced

- **Measured by** a `PerformanceObserver` on layout shifts, excluding any caused by input:
  - 0.19 when one breakdown card appeared;
  - 0.49 when the hold card replaced two cards;
  - 0.62 when the chaos hold appeared;
  - 0.145 when the crowd row reappeared above the hold.
- New cards go on top and push everything down without animation. A guest reading "Shortest waits" loses their place every time something breaks.
- **Fix:**
  - Animate insertions (grow from zero height).
  - Keep the reader's anchor when they have scrolled.
  - Reserve the crowd row's space instead of removing it.

### M10. Weather lags 5 minutes: "Lightning still nearby" while rides reopen, and the storm's end time is late. Reproduced

- **Lab:** `storm`; after the weather registers, `clear`.
- **What happened:**
  - The storm was cleared at 8:08:28. Rides said "Lightning still nearby" until 8:13:13, by which time 6 of the 21 held rides had reopened.
  - The first "passed" text was "Storm passed at **8:13 AM**", 5 minutes late.
  - There is no "storm passed" push at all, though that moment is the best news the app can give.
- **Why:** live reports are fetched every 5 minutes (`weather.js:16`). The lab's fake reports also carry no `TSE` remark, so the end time is the fetch time.
- **Fix:**
  - While a hold is open, fetch weather every minute.
  - Send "Storm passed at 3:12 PM. Rides usually back 3:40 to 3:50 PM" to phones following held rides.
  - Add `TSB`/`TSE` remarks to the lab's fake METAR.

### M11. The storm push leads with 18 ride names; the hold and the range are cut off on a lock screen. Reproduced

- **Pushed:** "18 rides just went down | Trick-or-Treat Locations at Mickey's Not-So-Scary Halloween Party, Seven Dwarfs Mine Train, Big Thunder Mountain Railroad, Walt Disney's Carousel of Progress, Enchanted Tales with Belle and 13 more / Park-wide hold at Magic Kingdom / Usually back in 50 min to 1 hr 10 min".
- A collapsed lock-screen notification shows about two lines: names of attractions. Nothing about lightning, the hold, or what to do. Grouped pushes also drop the verdict that single ones carry.
- **Fix:** "Storm hold: 18 rides closed" as the title. First line "Usually back in 50 min to 1 hr 10 min · Ride something indoors". Then the followed rides by name, headliners first.

### M12. "Back up recently" grows to 20 rows after a storm and stays for two hours. Reproduced

- After the 8:06 storm the list had 20 rows of "Back at 8:13 AM after 7 min". The dashboard keeps them for 2 hours (`index.js:143`), pushing "Shortest waits" far below the fold.
- **Fix:** collapse a hold's returns into one row ("18 rides back after the storm, 8:12 to 8:14") that expands on tap. Keep single returns for 30 minutes.

### M13. API responses are not compressed; first visit on slow 3G takes 10.4 s. Reproduced

- **Size:** the dashboard is **30.6 KB raw and 3.9 KB gzipped**, and API JSON is sent raw even with `Accept-Encoding: gzip`. Every 30-second refresh costs up to 30 KB, since the ETag changes every poll.
- **First visit on slow 3G:**
  - the page arrived at 2.3 s;
  - nothing but the background showed until 7.6 s, when `app.js` (140 KB raw) ran;
  - rides appeared at 10.4 s.
- **Tapped alert, cold start:** the boot awaits an extra `/api/trips/CODE` round trip before the dashboard (`app.js:3064`). That is 2 s on slow 3G.
- **Fix:**
  - gzip JSON over 1 KB in `json()` and the dashboard branch (`index.js:68-71`, `239-240`).
  - Inline a static skeleton in `index.html`.
  - Show the saved dashboard while the existence check runs, and check in parallel.

### M14. Detail pages cover the tab bar, and the large title never collapses. Reproduced

- **Tab bar:** a ride, park or hold page sits over the whole screen (`.pages` is fixed at `inset: 0`, z-index 40, over the tab bar's 20). To reach another tab a guest must go back first. iOS keeps the tab bar under pushed pages.
- **Title:** the header's large title is sticky and never shrinks into an inline title as iOS does on scroll. In landscape (852×393) the header and tab bar take half the screen.
- **Fix:**
  - Stop pages above the tab bar, with `bottom: var(--tabbar-h)`.
  - Collapse the large title into a 17 pt inline title after 40 px of scroll, as the pages already do.

### M15. The join field can't take a pasted code or invite text. Reproduced

- **Leading space:** pasting " MKLABS" becomes " mklab". `maxlength="6"` (`index.html:97`) counts the space and truncates the code; Join stays disabled.
- **Invite text:** pasting the invite message ("Join my ParkAlert trip at Magic Kingdom. Code MKLABS …") becomes "Join m".
- **Fix:** drop `maxlength`; on input, pull a `?join=` code or the last 6-character run of the code alphabet out of whatever was pasted.

### M16. Leaving a trip leaves ntfy phones subscribed, with no word about it. Reproduced

- The leave sheet says "This phone stops showing it". An ntfy phone keeps receiving the trip's alerts after leaving, because the subscription lives in the ntfy app.
- **Fix:** for phones set up with ntfy, add "Also remove `parkalert-…` in the ntfy app, or you'll keep getting its alerts", with the topic shown.

### M17. "Send a test" on the Trip tab and in ntfy setup buzzes every phone on the trip. Reproduced

- **What happened:**
  - Step 3 of the ntfy setup on an iPhone in Safari buzzed phones A and B with "ParkAlert test for trip MKLABS".
  - The Trip tab's "Send a test alert" row does the same, says nothing about it, and shows "Test alert sent. Check your notifications" even on a phone with no alerts set up.
- **Fix:**
  - The Trip row tests this phone: its own device, or its ntfy topic with a "this phone only" note.
  - Move "Test everyone's phones" under a confirm.

### M18. Wait alerts stop at 60 minutes, below every headliner's typical wait. Code

- The choices are 10, 15, 20, 30, 45 and 60, and only those below the current wait (`app.js:1964-1970`). The server accepts up to 240. For TRON, Flight of Passage or Slinky Dog at 90 to 150 minutes, "tell me when it's under 90" is exactly the alert a guest wants, and it can't be set.
- The push to everyone says "**You** asked for 20 min or less", including to phones that didn't.
- **Fix:**
  - Offer steps relative to the current wait: at 120, offer 100, 90, 75, 60 and 45.
  - Word it "Alert set for 20 min or less".

### M19. "Best time to ride" names hours that are already over or outside today's hours. Reproduced (lab hours) and Code

- The line is the minimum over all archived hours: "Usually shortest around 1 AM (40 min)" at 8 AM. In a real park at 4 PM it will name 9 AM, which helps nobody for the rest of today. It also ignores tonight's close and a party night's split hours.
- **Fix:** "Best time left today", limited to from now until today's close, with the all-day picture kept in the chart.

### M20. VoiceOver hears only the ride name on a down card; the verdict and times are hidden. Reproduced (axe-core) and Code

- The card's `aria-label` ("Trick-or-Treat Locations…, down 1 min. Show details", `app.js:1159-1160`) replaces its content. The verdict, the chances and "Likely back" are never read.
- **axe-core** also flagged:
  - `role="button"` on `<article>`;
  - the heading order skipping from h1 to h3 on Down now;
  - 4.45:1 contrast on the filter counts (4.5 needed).
- **Live region:** `#park-meta` is `aria-live` and, when stale, changes every minute ("2 min old", "3 min old"), so VoiceOver re-announces it every minute.
- **Fix:**
  - Use `aria-labelledby` for the name and `aria-describedby` for the verdict and time.
  - Make the card a `<button>` wrapping `<article>` content, or give it `role="link"`.
  - Fix the heading level.
  - Take `aria-live` off the ticking part of the meta line.


### M21. A ride that drops out of the feed while down, then comes back, never gets its "back up". Code

- **Confirmed by calling `applyLiveData` (`poller.js:30-90`) directly:**
  1. Space Mountain goes DOWN, and the "is down" event fires.
  2. It is missing from the feed for 6 polls, one more than `MISSING_POLLS`, and is dropped from state (`poller.js:83-87`).
  3. It comes back OPERATING. It is treated as a ride seen for the first time, so no event fires: no "back up", no outage length, no scorecard entry.
- **In the park:** partial snapshots from the feed are why `MISSING_POLLS` exists. A down ride that vanishes for six minutes leaves every phone's last word as "is down" for the rest of the day, and its card simply disappears from Down now.
- **Fix:**
  - Keep a missing ride's outage state (`downSince`, `downFrom`, last alert) for 30 minutes after it leaves the feed.
  - When it returns, diff against that state.
  - After 30 minutes, send "Space Mountain is no longer in the park's feed" rather than silence.

---

## Low

| ID | Evidence | Where | Finding | Fix |
|---|---|---|---|---|
| L1 | Reproduced | Rides at 375 px | The filter wraps "With alerts / 40" onto two lines, so one segment is taller than the rest | "Alerts" as the label, or the count as a badge |
| L2 | Reproduced | Crowd row, empty states | Times break before AM/PM: "usually 79 at 7 / AM", "Nothing was down as of 5:53 / AM" | A non-breaking space in `fmtTime` and `fmtHour` |
| L3 | Reproduced | "Shortest waits", hold rows | Separators are inset as if the rows had icons (`style.css` `.row + .row::before`) | The `.plain` inset for icon-less groups |
| L4 | Reproduced | Header | The meta chevron points down, as for a menu, but tapping pushes a page from the right | A right chevron, or none |
| L5 | Reproduced | Search | "7 dwarfs", "seven dwarves" and "big thunder mtn" find nothing; guests type numbers and nicknames | Digits as words, and an alias list (7DMT, BTMRR, mtn) |
| L6 | Reproduced | Two tabs | A switch changed in one tab showed in the other only after its next refresh (22 s) | A `storage` event or BroadcastChannel refresh |
| L7 | Reproduced | Ride page "Last 7 days" | "Typical 1 hr 1 min" for Tiana's Bayou Adventure mixes two storm holds with a 16-minute breakdown | Breakdowns only, or say "including storms" |
| L8 | Reproduced | Late openings | "Hasn't opened yet · down since 8:19 AM" contradicts itself. "Opened 5 min late" is the time since it went DOWN, not since opening time | "Late to open · noticed 8:19 AM", "Opened at 8:23 AM" |
| L9 | Reproduced and Code | Toasts | The toast sits over the Trip tab's "Park · Change" row, so a tap just after it fades opens the park picker. The update toast (an action) can replace an Undo toast | Toasts above content with a short tap guard after hiding; never replace an Undo with a non-urgent action |
| L10 | Reproduced | Pause, two phones | After phone B resumed the trip, phone A's sheet still offered "Resume for everyone", and "This phone gets alerts again" showed next to the pill "Paused" | Refresh the trip when a sheet opens |
| L11 | Reproduced | Offline | The crowd row shows "Big rides average 82 min" with no "as of" | Grey it and add "as of" |
| L12 | Reproduced | Server | `/%E0%A4%A` returns 500. Wait alerts accept unknown ride ids. Trip mute accepts negative times. `X-Forwarded-For` is trusted without a proxy, so off Railway any client picks its own rate-limit bucket | 400 for bad escapes; check the ride exists; `TRUST_PROXY` setting |
| L13 | Reproduced | Use my location | The Contemporary Resort is "You're at Magic Kingdom" (2 km radius), and the trip is created with no confirm; the esplanade between Disneyland and California Adventure is a coin flip | Preselect the park and let the guest tap Start; smaller radii |
| L14 | Reproduced | Invite | If `navigator.share` rejects for anything but a cancel, nothing happens: no copy, no message | Fall back to copying the link unless the error is `AbortError` |
| L15 | Code | Everywhere | Times are always 12-hour US (`LOCALE = 'en-US'`), whatever the phone uses | Format on the device; send epoch times in pushes |
| L16 | Reproduced | Copy | "6-letter code", but codes have digits (MS3ETN, TMMDT5). The test push says "a ride you follow"; the app says "alerts on" | "6-character code"; one term |
| L17 | Reproduced | iPhone install sheet | It sells "opens full screen", not that alerts only work from the Home Screen app. It says nothing about the trip (see S1). "The Share button in Safari's toolbar" may not match Safari's compact layout (S7) | Lead with "Needed for alerts on iPhone" |
| L18 | Reproduced (benchmark) | Server | With a year of archive, each new weather report clears every park's weather model; the next dashboard spends about 180 ms rebuilding all six synchronously | Rebuild only the park whose stations changed, off the request path |
| L19 | Reproduced | Pause sheet | Eight options in two identical lists. "7:00 AM" beside "Until 9:03 AM". No "Until the park closes" | A This phone / Everyone control over one list; consistent detail |
| L20 | Reproduced | Hold card | Rides inside a hold are in feed order, not followed-first or A to Z | Followed first, then A to Z |
| L21 | Reproduced | Park page | "Outages today: 5" skips Peter Pan's Flight, down since 2:53 AM that day, because only observed transitions count | Count outages that began today |
| L22 | Code | Wait trends | The arrow needs a change of 10 minutes over half an hour (`TREND_MIN_CHANGE`, `insights.js:100-113`), whatever the wait. A 120-minute headliner wobbling from 110 to 120 gets "up 10 min"; a 20-minute ride doubling to 30 gets the same arrow | A relative threshold, such as 25% and at least 10 minutes |
| L23 | Code | Lines building | The two-hour limit is per park and is used up before anyone is chosen (`notifyCrowds`, `poller.js:661-662`). A surge with no trip subscribed, or every trip paused, still blocks the alert for two hours; a family that switches it on right after gets nothing | Record the time per trip, after a successful delivery |
| L24 | Reproduced | Resuming the app | A tab frozen for 4 minutes while The Seas with Nemo broke woke on slow 3G. The header said "Ride times may be out of date · 5 min old", but the list under it said "Everything's running" for the 2.3 s the refresh took. On resume only the header is redrawn (`app.js:989-993`); the list waits for data or the 15 s tick | Redraw the whole view on resume, so the empty state switches to "Nothing was down as of 9:56 AM" at once |
| L25 | Reproduced | Lab and README | See the list below | |

**L25, the lab and its docs:**
- The README says the lab runs "with nothing leaving your machine". It fetches the real rosters from `api.themeparks.wiki` at start-up (`scripts/lab.js:44-52`).
- `storm` at EPCOT registers no lightning. The fake METAR takes the storm state from the first park using a station, which is always Magic Kingdom (`lab.js:196-201`).
- `closing` can never show auto-mute, because the server keeps its hours for an hour (H6).
- `slow` answers in 25 s against a 20 s client timeout, so it is really a second outage scenario. Use 12 s to test slowness.
- The panel ([screenshot](review-4/49-lab-panel.jpg)) doesn't show native pushes, doesn't show the tap links the brief refers to (they are in `/lab/state` but not rendered), and collapses each message's line breaks into one paragraph.
- Every lab restart resets the fake world. Rides down before a restart come back as "back up" pushes, and pending wait alerts fire.
- `--keep` reuses the seeded archive but re-rolls every ride's base wait and outdoor flag on start (`lab.js:343-355`). After a restart, the archive's headliners and weather-exposed rides no longer match the live fake park. A `rush` at EPCOT then moved the crowd index only from 62 to 72, too little to trigger lines building. Save the world with the data, or seed the world from a fixed random seed.
- `--auto` includes `closing` but never `reopen` or `recover` (`lab.js:382`). Once it picks `closing` for a park, that park stays closed and every later scenario there does nothing.

## Polish

| ID | Evidence | Finding |
|---|---|---|
| P1 | Code | The done step in setup draws a text check mark from CSS (`content: '✓'`) while every other icon is an SVG from one set. Not an emoji, but not the icon set either |
| P2 | Reproduced | iPad: one 640 px column with empty sides. A list and detail side by side would suit it |
| P3 | Reproduced | "Now 70 min. Tell me when the wait is at most (minutes):" reads like a form. Try "Alert me when the wait is at or under" |
| P4 | Reproduced | The pill's "No rides on" reads as "no rides are running". "No ride alerts" |
| P5 | Reproduced | The wait chart's y-axis keeps the morning's peak (120) all day, flattening the afternoon |
| P6 | Reproduced | At 200% the "Invite someone" button wraps with its icon stranded on the left |
| P7 | Reproduced | Legend squares for "15 min 0%" and "30 min 0%" are drawn in full colour next to empty bars |
| P8 | Reproduced | Hold cards use a lightning bolt even when no weather is involved (H2), which implies a storm |


## Words

Strings a first-time guest would stumble on, beyond those in the findings above.

| Where | Now | Problem | Try |
|---|---|---|---|
| Verdict | "Check back soon" | Soon is not a time | "Check back in about 20 min" |
| Verdict | "Ride something nearby" | Nearby to what? The app doesn't know where the guest is | "Stay close: likely back within the hour" |
| Push, hold card | "Park-wide hold" | Insider jargon. It also shows a lightning bolt when no weather is involved | "Storm hold" when the weather confirms it, else "Several rides paused at once" |
| Push | "By the 30-minute rule, back in 30 to 45 min" | The rule is never explained in the push | "Rides reopen about 30 min after the last lightning: 3:40 to 3:55 PM" |
| Push | "3 rides just went down" | Sent up to 5 minutes late when held (H1), so "just" is false | "3 rides went down at 8:45 AM" |
| Push | "Down 6 min to 5 hr 20 min" | A span across a group hides the ride that matters | Name long outages separately (H4) |
| Push | "Was down a while" | Used when the length is unknown, which is when a guest most needs a time | "Back up. It was down before 9:11 AM" |
| Card and ride page | "Likely back 8:05 AM to 8:27 AM", and "Likely back between 8:05 AM and 8:27 AM" | One idea, two phrasings | One phrasing everywhere |
| Setup sheet | "Or use the ntfy app instead" | "ntfy" means nothing to a guest | "Or get alerts through ntfy, a free app" |
| Trip tab | "Via ntfy" | Same | "Through the ntfy app" |
| Setup sheet | "Set up later" on a phone that is already set up (M3) | Contradicts the header | "Done" |
| Toast | "Still connecting. Try again in a moment." | Shown when "Change" park is tapped while a park switch is loading (`withDash`, `app.js:2861`). The connection is fine | "Switching parks…", or queue the tap |
| Hold page | "These run longer than a breakdown, and the rides tend to reopen together" | True for storms. In H2's coincidental "holds" it's false | Say it only for weather holds |

## What's missing

What a guest would expect and can't find:

- **Who's on the trip.**
  - The server counts the trip's phones (`phones` in every trip response), but the Trip tab never shows it.
  - A family can't tell whether the other phone is set up. "2 phones get alerts: this one and 1 other" would settle it.
- **An alert history.**
  - Once a notification is swiped away, or replaced (H4), the only record is "Back up recently", which lasts two hours.
  - A family member who wasn't looking can't see what happened this afternoon.
- **A short list of the family's rides** (idea 1). Today it is all attractions or hand-picking 36 switches.
- **Lightning Lane.** The list already shows "Lightning Lane 2:15 PM". An alert when the next return time jumps, or when Single Pass sells out, is the other thing guests watch all day.
- **Other parks' crowds.** Park hoppers choose between parks; the crowd level exists only for the trip's current park.
- **Planning from the hotel.** Only today's hours are known; there is nothing for tomorrow.
- **What's closed for refurbishment.** Those rides sit in the Rides list among the running ones.

---

## Suspected (not reproduced)

| ID | Would be | Suspicion | How to confirm | Fix if confirmed |
|---|---|---|---|---|
| S1 | Critical | iPhone Home Screen apps have storage separate from Safari. The trip lives in Safari's `localStorage`, and the manifest's `start_url` is `/` (the app also rewrites the address to `/`). A guest who follows the setup sheet ("Add it there, open it from its icon, and turn notifications on from this screen") would open the icon to the first-run screen with no trip. Tapping a park there creates a new, separate trip | On iOS 18 or later: join a trip in Safari, add to Home Screen, open the icon | A per-trip manifest with `start_url=/?trip=CODE`, or keep `?trip=` in the address while the install sheet is open; in the Home Screen app, detect "no trip, opened standalone" and ask for the code first |
| S2 | Medium | The Home Screen badge is set only from the open page (`app.js:1074`). With the app closed, pushes arrive but the badge keeps its old count, such as "3" hours after the rides reopened | Real device, app closed during a storm | Include the down count in the push and call `setAppBadge` in the service worker |
| S3 | Low | The Android notification badge is `icon-192.png`, which has no alpha channel (colour type 2), so it shows as a solid white square in the status bar | Android phone | A monochrome transparent badge PNG |
| S4 | Medium | The service worker has no `pushsubscriptionchange` handler. If the push service rotates a subscription while the app is closed, the old endpoint returns 410, the server drops the phone, and it stays silent until the app is next opened, while its pill still says "Alerts on" | Firefox, which rotates, or a forced rotation | Re-subscribe and re-register in the service worker |
| S5 | Medium | After a real storm, reopened headliners post high waits at once. With H5's shrinking set, the index can jump by a third and send a false "Lines are building" right after the hold. The lab reopens rides at their base wait, so it can't show this | Replay a real storm day's waits | H5's fix |
| S6 | High | Real-world volume. The lab averaged about one push a minute, and it seeds only 3 to 9 outages per park per day. Every outage of a followed ride costs two pushes, so a phone following all 36 attractions gets twice the real daily outage count before storms | Count outages per day in the production `history.json` (the backtest reads it) | H8, H3, H1 |
| S7 | Low | Safari's newer compact layout keeps Share in a "…" menu; the install sheet's steps assume a toolbar Share button | Current iPhone | Word the step for both layouts |
| S8 | Medium | "Is down" pushes go out with `Urgency: normal`, because priority 3 maps below the `high` cut-off (`deliver.js:24`); the fake push service logged `normal` for every "down". Android and FCM hold normal-priority messages while the phone dozes, so the alert a guest most wants to be fast can arrive minutes late, while "back up" (priority 4) is sent `high` | An Android phone, screen off for 30 minutes, then `breakdown` | Send "down" and "closed" with `Urgency: high`, as "back up" and wait alerts already are |

---

## Standing preferences

- **No purple:**
  - None in `style.css`, the templates or the icons. The icon's gradient runs from night blue to orange.
  - The lab panel is plain grey with blue links.
- **No emoji as icons:**
  - None in the UI or in pushes, which carry no ntfy tags.
  - Emoji appear only in the lab's hostile ride name, which is data.
  - P1's text check mark is the one non-SVG glyph.
- **No loud bordered banners:**
  - None. Warnings are orange text in the header and toasts are borderless.
- **The first screen leads with an action:**
  - First run leads with "Use my location", and a new trip opens the alert setup sheet.
- **No em dashes in docs or UI text:**
  - None in the README, the audits, the UI or the push text. The sort button uses an en dash ("A–Z").

## Alert volume, measured

Trip `MKLABS`, all rides following, one phone, 07:57 to 09:13.

| | Count |
|---|---|
| All pushes | 72 in 75 minutes |
| Single "X is back up" | 43 |
| Single "X is down" | 9 |
| Grouped "went down" | 8 |
| Grouped "back up" | 7 |
| Closed, lines building, wait alert, test | 5 |
| Busiest 10 minutes | 17 pushes (the 8:06 storm and its reopening) |
| One "recover" (all rides reopen in one poll, 9:16) | 5 pushes |
| A 20-second flap | 2 pushes ("down", then "back up · Was down <1 min") |

The lab is deliberately busy. Still, the ratio is the finding: most buzzes are "back up" for rides the guest was never going to ride.

In the 20 minutes of emulated `--auto` (13 random scenarios), `MKLABS` got 6 pushes, `EPLABS` 4 and `DLLABS` 0. Two of the ten were wrong in kind: an early-close "24 rides have closed", and a "3 rides just went down" sent 2.5 minutes late. Auto mode picked `closing` for Magic Kingdom at 9:43, and that park stayed dead for the rest of the run (L25).

## What held up

- Rapid switch toggles: five taps in half a second ended in the same state on screen and on the server.
- "Turn all on" with Undo.
- Park switch with Undo.
- Leave with Undo, which restored the ntfy "working" flag.
- Back pressed mid-animation, a double-tapped row, and a double Back.
- The left-edge swipe, including a short flick.
- Rotating mid-drag.
- Reduced motion.
- Deploy while open. The update was offered within 15 s (9 s and 13 s on the two phones). With the app put away it reloaded onto the new version and reopened the ride page it was showing.
- Offline cold start from the service worker, with "Offline · as of 5:53 AM".
- A tab left frozen for an hour, across a deploy, woke in 56 ms to the current state and offered the new version. On slow 3G after a shorter freeze, the header flagged the old data at once and fresh data arrived in 2.3 s (L24 has the one gap).
- Wrong codes by typing, invite link and alert link, each with its own clear message.
- Per-phone and trip-wide pause for ride alerts. The paused phone got nothing; the other phone and ntfy did.
- The chart scrub. It follows the finger, returns to "Now" on lift, and still lets the page scroll vertically.
- Hostile ride names: markup is escaped everywhere, and long names wrap.
- Validation, 413s, the code-guessing limiter with its known-code exemption, CSP and the other headers.
- A year of archive: 14.5 MB of history loads in 47 ms, adds 21 MB of memory, and everything except L18 answers in under a millisecond.

## The 10 fixes that matter most

1. **Alerts open the truth (C1).** Refresh before opening a tapped alert, prefer fresh ride detail, and have the service worker tell an open app to refresh when a push lands.
2. **Debounce state, not time (H1).** Send "down" at once, hold only "back up" until it has stuck for two polls, and fold held events into groups.
3. **One storm, one thread (H3, H4, M11).** A hold is an incident with its own tag. The closing push leads with "Storm hold" and what to do, then "6 of 18 back" updates replace it, then "All back". Name any ride that returns after a long outage.
4. **Hold means simultaneous (H2).** A 2 to 3 minute window. Never reclassify a ride already announced. One start time and one verdict per hold card.
5. **A crowd level that ignores outages (H5).** Per-ride ratios to the usual for this hour, a minimum of 5 headliners, 15-minute smoothing, and paused during holds.
6. **Say what the park is actually doing (H6, H11, M1).** Empty states and muting that agree with ride statuses, not just posted hours; a schedule refetch when the two disagree; a feed-down state that names the feed and says alerts are paused.
7. **Large text works (H7).** No horizontal overflow, a trip code that always fits, and phone-sized margins at accessibility sizes.
8. **Fewer, better alerts by default (H8).** Follow the headliners (or a "my rides" list, idea 1) by default, and keep non-rides out of the alert list.
9. **Never go silent without saying so (H9, H10, M17).** Keep a trip with phones alerting on its park days, or warn before it idles. Mark a wait alert used only when a phone got it. Make "Send a test" test this phone.
10. **Patchy-signal performance (M2, M13).** Compress API JSON, never make reads wait on a poll, render the saved dashboard before any existence check, and base "Updated" on ride-data age.

## The 3 biggest product ideas

1. **"My rides" and "Heading there".**
   - At setup, pick the family's must-do list (the park's headliners, preselected). Alerts are for those; everything else is quietly visible in the app.
   - On a ride page, "I'm heading there" (or "In line") turns on instant alerts, a wait threshold and the reopen countdown for that ride for the next hour.
   - This cuts most of the noise measured above. It also answers the question a guest actually has ("is *our* next ride OK?") and gives the lines-building alert a real list to suggest from.
2. **Storm mode.**
   - Florida summer afternoons are when ParkAlert matters most, and the app already has the data. Make a storm one live screen and one push thread:
     - "Storm hold: 18 rides closed. Indoor rides running: …";
     - "Lightning moved away at 3:12 PM. Rides usually back 3:40 to 3:50 PM";
     - "12 of 18 back".
   - Poll weather every minute during a hold. Suggest the indoor rides with the shortest waits against their usual.
   - Timing the reopening from the storm's end is the thing ParkAlert already knows how to do that a wait-times app doesn't. Make it the headline.
3. **"Better than usual right now".**
   - Replace "Shortest waits" and the lines-building alert with one recommendation: rides on the family's list whose wait is well below their usual for this hour ("Space Mountain 20 min, usually 55"), limited to what is still open and to the time left today.
   - One opt-in push per park day when a must-do ride drops well below its usual.
   - It turns the wait archive into the decision guests are trying to make, and it's built from data ParkAlert already keeps.

### What to cut

- **The park page's "How the estimates did"** scorecard and **"Most outages, last 7 days"**. They are diagnostics, not decisions, and "0% in range" undermines the estimates guests do need. Move them behind `/api/health?token=`.
- **The trip-wide "Send a test alert" row**, replaced by a this-phone test (M17).
- **Two of the three chance numbers on the card.** Keep the verdict and one sentence, and leave the full curve to the ride page.
- **The 10-segment crowd meter**, once the level is a sentence (M6). It repeats "6/10" as shapes.
