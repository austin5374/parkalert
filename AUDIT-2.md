# ParkAlert audit 2: native feel and QA

Date: 2026-09-28. Branch `audit-2`, from `main` at `4b63cd2`. Written before any code changed. Nothing in AUDIT.md is reported again.

The standard is Apple's own apps: Maps and Find My for sheets, Weather for data, Settings for lists and switches, Mail for pull-to-refresh and swipe actions. Anything that works differently from them, feels slower, looks slightly off, reads awkwardly or leaves a guest unsure what happened counts as a finding.

## How this was tested

- `npm ci` and `npm run check`: lint is clean and **154 of 154 tests pass**.
- The real server ran locally, with `DATA_DIR` in a temp folder. The repo's own fakes (`tests/fakes.js`) stood in for ThemeParks.wiki, ntfy and both weather feeds. They served recorded-style fixtures: 30 Magic Kingdom rides, including long names, curly apostrophes and an accented name; a week of outage history; a 7-ride hold; a six-hour outage; and a mid-day close.
- Nothing touched the live URL, the production volume or a real ntfy topic, and no railway commands were run.
- **Devices:** headless Chrome driven over the DevTools protocol, with device metrics, touch emulation, media features and network throttling. Sizes: iPhone SE (375×667), iPhone 15 (393×852), a large Android (412×915), 320×568, landscape (852×393) and iPad (820×1180).
- **Settings:** light and dark mode, reduced motion, and 200% text (root font size doubled, since the layout is in rem).
- **Gestures:** swipes, flicks, holds and scrubs were real touch sequences with measured positions. They were not synthetic clicks.
- **Network:** slow (2 s latency), offline, and a server answering 502 the way Railway's proxy does when the app is down.

Each finding is marked:
- **Reproduced**: seen happening in the running app.
- **Code**: follows deterministically from the code, but I didn't trigger it at runtime.

Anything I only suspect is in [Suspected](#suspected-not-reproduced). Anything that needs a phone is in [Needs a real iPhone](#needs-a-real-iphone-in-standalone-mode-unconfirmed).

Severity:
- **High**: breaks a core job, or a guest ends up misinformed.
- **Medium**: clearly wrong or clearly un-native.
- **Low**: a rough edge.
- **Polish**: craft.

## Summary

| ID | Sev | Area | Finding |
|---|---|---|---|
| A1 | High | Sheets | Only the grabber and title drag a sheet; the content never does |
| A2 | High | Sheets | Browser and Android back leave the app instead of closing the sheet |
| A3 | Medium | Sheets | A sheet that grows after opening closes short, then pops out of existence |
| A4 | Medium | Sheets | Flicks need to be long to close; a held-still release still flings |
| A5 | Medium | Sheets | A ride opened from the hold or park sheet has no way back, and focus is lost on close |
| A6 | Medium | Sheets | The hold sheet never refreshes |
| A7 | Low | Sheets | Opening a sheet while one is closing makes it jump |
| A8 | Low | Sheets | A live refresh can swap content under a grabber drag |
| A9 | Polish | Sheets | No half-height detent; tall sheets leave a flat 24 px gap |
| B1 | High | Deep links | Tapping any push opens the home screen, never the ride |
| B2 | Medium | Navigation | Each tab loses its scroll position on every switch |
| B3 | Medium | Deep links | An invite opened with no signal is thrown away |
| B4 | Low | Navigation | Invite toast and setup sheet land on top of each other |
| C1 | High | Search | Search misses accents, apostrophes, "the" and word order |
| C2 | Medium | Controls | Double-tapping a park on a slow connection creates two trips |
| C3 | Medium | Controls | The header pill is 33 px tall; switches are 30 px |
| C4 | Medium | Search | Search keeps the keyboard up on Enter and on scroll |
| C5 | Medium | Lists | No filter for down, followed or open; no Lightning Lane or single rider |
| C6 | Low | Lists | The row's disclosure chevron sits mid-row, after the wait |
| C7 | Low | Lists | "Shortest wait" puts running rides with no posted wait after 90-minute ones |
| C8 | Low | Controls | Switches can only be tapped, not dragged |
| C9 | Low | Lists | A 30-ride hold is 30 identical cards |
| C10 | Polish | Controls | Pause options don't say when they end |
| D1 | High | State | Failed toggles can leave a switch showing what the server never saved |
| D2 | Medium | State | A server outage shows as "Offline" on a phone that is online |
| D3 | Medium | State | "Everything's running" when the park is closed, or when offline |
| D4 | Medium | State | A new deploy never tells the open app to reload |
| D5 | Medium | Feedback | Pull to refresh gives no feedback when nothing changed or it failed; no pull on sheets |
| D6 | Medium | Feedback | One toast slot: a second toast wipes an Undo; toasts cover sheet buttons |
| D7 | Medium | State | Switching parks shows the old park with no sign anything is happening; its Undo can fail silently |
| D8 | Low | State | "Alerts on" with zero rides followed |
| D9 | Low | Feedback | Follow all has no confirmation or Undo; Unfollow all does |
| D10 | Low | Feedback | The ride sheet's switch doesn't roll back when the save fails |
| D11 | Low | Feedback | No haptics anywhere a native app has them |
| D12 | Low | State | Leaving a trip leaves its cached data and flags behind |
| E1 | Medium | Charts | The scrub readout never resets after lifting the finger |
| E2 | Medium | Numbers | "Last 7 days" shows Typical and Longest over the whole archive |
| E3 | Low | Charts | Chart labels ignore text size; 30 day labels overlap |
| E4 | Low | Numbers | Grouped "back up" pushes drop the durations single ones carry |
| E5 | Low | Numbers | Push times ignore the phone's 12/24-hour setting |
| E6 | Low | Charts | The wait chart has no hour ticks and no zero |
| F1 | High | Visual | At 200% text the header collapses to "Ma g…" and rows break |
| F2 | High | Preference | The icon and splash are purple |
| F3 | Medium | Visual | Manifest theme is light-only; the splash color doesn't match either theme |
| F4 | Low | Visual | Install row uses the share glyph |
| F5 | Polish | Visual | Wait chips orphan one chip on a second line |
| F6 | Polish | Visual | Recent outages list the time on some rows but not on holds |
| G1 | Medium | Words | Follow, alerts, watch and mute name one idea four ways |
| G2 | Medium | Words | The test push says "this phone" to every phone on the trip |
| G3 | Low | Words | Misleading or clumsy strings (list inside) |
| G4 | Low | Preference | Em dashes in two comments; emoji used as icons in the README and pushes |
| H1 | High | Correctness | A ride still down after a hold ends is quietly reclassified as a breakdown |
| H2 | Medium | Correctness | Park hours are fetched once a day and never re-checked |
| H3 | Low | Correctness | A park day starts an hour off on daylight-saving days |
| H4 | Low | Correctness | Overnight "at least 13 hr" outages inflate Longest |
| I1 | Medium | Estimates | The scorecard and backtest only score rides that reopened |
| I2 | Low | Estimates | The backtest classifies with hindsight the live app doesn't have |
| I3 | Low | Estimates | The scorecard scores unrounded ranges, not what guests were shown |
| J1 | Medium | Persistence | A corrupt trips.json is silently replaced with an empty one |
| J2 | Low | Persistence | Large files are rewritten synchronously on the poll thread |
| J3 | Low | Persistence | Shutdown drops held alerts and in-flight pushes |
| K1 | Medium | Security | Per-IP limits key on the full IPv6 address, and one IP's typos lock out valid trips |
| K2 | Low | Security | `/api/health` is public |
| L1 | Low | Cost | Phones poll the full dashboard every 30 s with no 304, even when the park is closed |
| M1 | Medium | Service worker | Network-first shell with no timeout |
| N1 | Low | README | README claims that don't hold (list inside) |
| O1 | Low | Tests | Tests that pass without testing much, and missing ones |

---

## A. Sheets and pop-ups

### A1. Only the grabber and title drag a sheet; the content never does. High, Reproduced
- **Where:** `public/app.js:239-248`. In the scrolling body, only `.sheet-head` starts a drag.
- **Steps:**
  1. Open any ride sheet.
  2. With its content scrolled to the top, put a finger on the "Alerts for this ride" group and drag down 350 px.
  3. The sheet stays at `translateY(0)`, and the content bounces.
- **Native:** Maps and Find My sheets move from anywhere. When the content is at the top, pulling down hands off from the scroll view to the sheet, one continuous motion.
- **Who and when:** Anyone in a line with one hand. The grabber is a thin target at the top of a tall sheet; the thumb is at the bottom.
- **Fix:** Take drags from the whole sheet. While the body is at `scrollTop <= 0` and the finger moves down, move the sheet. Otherwise let it scroll. Switch mid-gesture when the content hits the top, as UIKit does. Use `touch-action: pan-y` on the body plus a `touchmove` handler that calls `preventDefault` only while dragging the sheet.

### A2. Browser and Android back leave the app instead of closing the sheet. High, Reproduced
- **Where:** `public/app.js:192-210`. No `history.pushState` and no `popstate` handler anywhere.
- **Steps:** Open a ride sheet, then press browser back. The page navigates away (in the test, to the previous page). On Android, the back gesture exits the PWA.
- **Native:** Back dismisses the topmost modal first. Android's predictive back does the same.
- **Who and when:** Android guests, constantly, and anyone using ParkAlert in a Safari tab. They lose the app mid-thought.
- **Fix:** Push a history entry when a sheet opens (`{sheet: 'ride', id}`). Close on `popstate`, and `history.back()` when closing by other means. The same entry makes A5's "back to the hold" work.

### A3. A sheet that grows after opening closes short, then pops out of existence. Medium, Reproduced
- **Where:** `public/app.js:199`. The height `h` is measured once, in `open()`, before the ride history loads.
- **Steps:**
  1. Open a ride sheet. `h` is 747 px.
  2. The history loads and the sheet grows to 828 px.
  3. Tap outside. The recorded frames show the sheet stopping at `translateY(747px)` with 81 px still on screen when the layer is hidden.
- **Also affected:**
  - The drag-to-close threshold (`h * 0.45`) and the scrim fade both use the stale height.
  - A 40% slow drag closed the sheet: 331 px was past 45% of the stale 747, though not of the real 828.
- **Native:** The sheet slides fully off-screen and the dimming fades to zero at the same moment.
- **Who and when:** Everyone, on every ride sheet. It reads as a glitch.
- **Fix:** Read `panel.getBoundingClientRect().height` at the start of each close and each drag, or keep it current with a `ResizeObserver`.

### A4. Flicks need to be long to close; a held-still release still flings. Medium, Reproduced
- **Where:** `public/app.js:149` (`project(v, rate = 0.99)`), `public/app.js:222-238`.
- **Steps:**
  1. Flick the grabber down 70 px in 70 ms (about 1,000 px/s). The sheet springs back open.
  2. With rate 0.99, a 1,000 px/s flick projects only 99 px, so a flick has to travel about 240 px before it closes.
  3. Separately, velocity comes only from `pointermove` samples. Drag, stop, and hold still for half a second: the release still carries the old speed, because no sample records the stop.
- **Native:** UIKit projects with the scroll view's deceleration rate (0.998), so a short, fast flick dismisses. A finger that stops before lifting has zero velocity and springs back.
- **Who and when:** Anyone trying to flick a sheet away between rides. It feels sticky, then occasionally over-eager.
- **Fix:**
  - Use `project(v, 0.998)`.
  - In `up()`, drop samples older than about 80 ms before computing velocity, so a pause means zero.
  - Keep the 45% position rule for slow drags.

### A5. A ride opened from the hold or park sheet has no way back, and focus is lost on close. Medium, Reproduced
- **Where:** `public/app.js:192-204`. `open()` on an open sheet swaps the body and takes `returnFocus` from inside the sheet it is replacing.
- **Steps:**
  1. Tap "Park-wide hold · 7 rides", then tap Seven Dwarfs Mine Train. The ride replaces the hold list; there is no back control.
  2. Press Escape. `document.activeElement` is `BODY`, not the hold header.
- **Native:** Find My pushes a detail card onto the sheet with a back chevron and slides it. Closing returns focus to what opened the first sheet.
- **Who and when:** A guest checking each ride in a storm hold has to reopen the hold sheet every time. VoiceOver users lose their place.
- **Fix:** Keep a small stack in the sheet: push the ride view with a "‹ Hold" button in its header, pop it on back (A2). Save `returnFocus` only when opening from closed.

### A6. The hold sheet never refreshes. Medium, Code
- **Where:** `public/app.js:1482-1483`. Only the `ride` and `park` contexts reload; `openHold` (`:1214`) sets `{type: 'hold'}`.
- **Steps:** Open the hold sheet and leave it open while rides reopen. The list keeps showing every ride as down, with elapsed times frozen at the moment it opened.
- **Native:** Weather and Find My update open cards in place.
- **Who and when:** Exactly the storm case, when people leave the sheet up and wait.
- **Fix:** Rebuild the hold sheet in `fetchDashboard` through `updateSheet`, and tick its durations with the 15 s timer. If the hold has ended, say so in the sheet.

### A7. Opening a sheet while one is closing makes it jump. Low, Code
- **Where:** `public/app.js:200`. `if (!isOpen) paint(h)`: during the close animation `isOpen` is already false.
- **Steps:** Close a sheet and, within 300 ms, tap another card. The sheet snaps to the bottom and rises again. The first sheet's `onClose` never runs, so `sheetContext` is briefly wrong.
- **Native:** Presentations are interruptible from the current position.
- **Fix:** Track "closing" separately. When re-opening mid-close, animate from the live `y`. Run the pending `onClosed` before replacing it.

### A8. A live refresh can swap content under a grabber drag. Low, Code
- **Where:** `public/app.js:252-264`. `touching` is only set by `pointerdown` on the body, not the grabber.
- **Steps:** Drag the grabber slowly while the 30 s refresh lands. The body is replaced mid-gesture and the height changes under the finger (compounding A3).
- **Fix:** Set `touching` from `down()` too, and flush the deferred update on release.

### A9. No half-height detent; tall sheets leave a flat 24 px gap. Polish, Reproduced
- **Where:** `public/style.css:369`.
- **Steps:** Open a ride sheet on an iPhone 15. It rises to full height with a 24 px strip of dimmed page above, and the page doesn't recede.
- **Native:**
  - Maps opens detail at a medium detent and expands on drag.
  - Full-height iOS sheets scale the page behind back slightly and round it, leaving the status bar clear.
- **Who and when:** Mostly craft, but a medium detent would keep the Down list visible while glancing at a ride.
- **Fix:** Start ride sheets at about 55% with a large detent on drag or scroll. Optionally scale `#app` to 0.94 with a rounded top while a full sheet is up (skipped under reduced motion).

Checked and fine for sheets: tap outside closes; Escape closes; the page behind doesn't scroll or jump; `inert` keeps Tab inside; the dialog is labelled by its title; focus returns to the opening control in the simple case; and a double tap on a card opens one sheet with one fetch. No sheet has a text field, so the on-screen keyboard can't open inside one.

## B. Navigation and deep links

### B1. Tapping any push opens the home screen, never the ride. High, Reproduced
- **Where:** `server/poller.js:335` and `:357` (`click: APP_URL`), `server/index.js:292`. `public/app.js:1656-1681` reads only `?join=`.
- **Steps:**
  1. Put a ride down and read the recorded push: `"click": "http://localhost:3000"` for "7 rides just went down".
  2. Every push, single or grouped, links to `/`.
- **Native:** A Mail or Find My notification opens the exact message or item.
  - "Space Mountain is down" should open Space Mountain's sheet.
  - "7 rides just went down" should open the hold sheet.
  - A wait alert should open the ride with its wait chart.
- **Who and when:** Everyone, at the moment of highest intent: the push arrives, they tap, they land on a list and have to hunt.
- **Fix:**
  - Send `click: ${APP_URL}/?ride=<id>` for single pushes, `?view=hold` for grouped holds, and `?view=down` for other groups.
  - On boot and on `visibilitychange`, open the named sheet once the dashboard has loaded.
  - If the ride has left today's live data, open a history-only sheet.
  - See also R1 (iOS may open Safari, not the home-screen app).

### B2. Each tab loses its scroll position on every switch. Medium, Reproduced
- **Where:** `public/app.js:1519`. `switchView` always calls `scrollTo({top: 0})`.
- **Steps:** On Rides, scroll to 500, go to Trip, come back. `scrollY` is 0.
- **Native:** Every tab bar app keeps each tab's scroll position. Only tapping the current tab again scrolls to the top, which this app does get right.
- **Who and when:** Anyone comparing a ride halfway down Rides with Down now.
- **Fix:** Store `scrollY` per view before switching and restore it after, in a `requestAnimationFrame`.

### B3. An invite opened with no signal is thrown away. Medium, Reproduced
- **Where:** `public/app.js:1659`. `history.replaceState` runs before the lookup.
- **Steps:** Clear storage, go offline, open `/?join=A79UDR`.
  - The toast says to "join with code A79UDR".
  - The URL is already `/`, and the join field is empty.
  - Coming back online does nothing with the code.
- **Native:** A shared link that can't open yet is kept and retried; Messages and Maps queue it.
- **Who and when:** The second phone, opening the invite in the parking lot or at security with one bar.
- **Fix:** Keep the pending code until the join succeeds. Prefill `#join-code` and retry on `online`. Only clear the URL after success.

### B4. Invite toast and setup sheet land on top of each other. Low, Reproduced
- **Where:** `public/app.js:1664-1668` with `showApp({ firstRun: true })`.
- **Steps:** With a trip saved, open another trip's invite. The setup sheet opens, and "Joined trip A79UDR · Undo" floats over its "Send test alert" button (screenshot: the toast covers the button's label).
- **Native:** One thing at a time. A confirmation would come first; a banner never covers a primary button.
- **Fix:** Ask first in a small sheet: "Join Austin's trip at Magic Kingdom? You'll leave trip NPRTGC", with Join and Cancel. Then show the setup sheet. Drop the toast.

Every screen answers "where am I" (the large title), "what can I do" and "how do I get out", except the stacked sheets in A5.

## C. Lists, search and controls

### C1. Search misses accents, apostrophes, "the" and word order. High, Reproduced
- **Where:** `public/app.js:647-649`. A lowercase substring match on the raw name.
- **Steps (results with the fixture names):**
  - `remy` and `remys`: no match for "Rémy’s Ratatouille Adventure".
  - `peter pans`: no match for "Peter Pan's Flight".
  - `its a small`: no match for "it's a small world".
  - `mountain space`: no match.
  - `splash n soak`: no match for "Casey Jr. Splash ’N’ Soak Station".
  - `the haunted`: no match for "Haunted Mansion".
- **Native:** Apple's search folds case, diacritics and punctuation, and matches every word in any order.
- **Who and when:** Guests typing fast, one-handed. Apostrophes and accents are all over Disney ride names.
- **Fix:**
  - Normalize both sides: NFD, strip combining marks, map ’ and ' to nothing, and replace other punctuation with spaces.
  - Drop a leading "the".
  - Require every query word to prefix-match some word of the name.
  - Reuse `sortKey`'s idea. Add a unit test with these cases.

### C2. Double-tapping a park on a slow connection creates two trips. Medium, Reproduced
- **Where:** `public/app.js:374-381`. No in-flight guard or pressed state.
- **Steps:** With 2 s latency, double-tap "EPCOT" on the setup screen. `trips.json` went from 1 trip to 3 (two new ones). For several seconds nothing on screen changes: no spinner, row highlight or status text.
- **Native:** The row highlights, a spinner replaces the chevron, and further taps are ignored.
- **Who and when:** First run on park Wi-Fi or at the gate. The guest ends up on one trip and invites a partner to the wrong one.
- **Fix:** Disable the list and show a spinner on the tapped row while `POST /trips` is in flight. Also guard in `startTrip` with a module-level promise.

### C3. The header pill is 33 px tall; switches are 30 px. Medium, Reproduced
- **Where:** `public/style.css:187-192` (pill), `:306-307` (switch).
- **Steps:** Measured at 393 px: `#btn-alerts` is 105×33 and each ride switch is 50×30. On the rows, a tap a few pixels above or below the switch lands on the row button and opens the sheet instead of toggling.
- **Native:** 44 pt minimum. In Settings the whole trailing area around a switch toggles it.
- **Who and when:** Anyone tapping a switch while walking. Mis-taps open a sheet they then have to dismiss.
- **Fix:** Give the pill a 44 px hit area, using the same padding and negative-margin trick as `.text-btn`. Make each switch's hit area the full row height and about 64 px wide with a `::before` inset.

### C4. Search keeps the keyboard up on Enter and on scroll. Medium, Reproduced
- **Where:** `public/app.js:1599`. `#ride-search` isn't in a form and has no `keydown` or scroll handling.
- **Steps:** Focus the search, press Enter. `document.activeElement` is still `#ride-search`, so the keyboard stays. Scrolling the results doesn't dismiss it either.
- **Native:** In the Settings and Mail search fields, Return dismisses the keyboard, and scrolling the results dismisses it interactively.
- **Who and when:** Everyone who searches; the keyboard covers half the results.
- **Fix:** On Enter, `blur()`. On the first `touchmove` of the page while the field is focused, `blur()`. Wrap it in `<form role="search">` so iOS shows "Search" and dismisses on submit. The clear button is the native `type=search` one, which is fine.

### C5. No filter for down, followed or open; no Lightning Lane or single rider. Medium, Code
- **Where:** `public/index.html:105-108`, `server/themeparks.js:43-53`. Only `queue.STANDBY.waitTime` is kept.
- **What's missing:** Rides has A–Z and Shortest wait, but no way to show only down rides, only rides you follow, or only open rides. ThemeParks.wiki live data also carries `RETURN_TIME`, `PAID_RETURN_TIME` and `SINGLE_ACTOR` queues, which are discarded.
- **Native:** Weather-style data apps surface the field a user needs at a glance. Disney's own app shows Lightning Lane and single rider on the row.
- **Who and when:** Guests deciding what to ride next.
- **Fix:**
  - Add a compact filter menu (All, Open, Down, Following) beside the sort.
  - Keep `singleRider: !!queue.SINGLE_ACTOR` and the return window on each ride, and show a small text tag ("Single rider", "LL 3:40 PM"), not an emoji.

### C6. The row's disclosure chevron sits mid-row, after the wait. Low, Reproduced
- **Where:** `public/app.js:671` (`meta-chevron` inside the meta line).
- **Steps:** On Rides, the chevron floats right after "Open · 10 min wait" at a different x on every row. It reads as part of the text.
- **Native:** In Settings, a row with a switch has no chevron. Tappability comes from the row highlight on touch-down, and details live behind a separate (i) button where both exist.
- **Fix:** Drop the inline chevron and rely on the row press state. Optionally add a trailing (i) button before the switch, as Wi-Fi settings do.

### C7. "Shortest wait" puts running rides with no posted wait after 90-minute ones. Low, Code
- **Where:** `public/app.js:627-631` (`waitTime ?? Infinity` within the OPERATING rank).
- **Steps:** A running ride that posts no wait (PeopleMover, Railroad, walk-throughs) sorts after "Open · 90 min wait".
- **Native:** Walk-on attractions are the shortest wait.
- **Fix:** Sort running rides with no posted wait first, labelled "Open · no posted wait", or in their own group.

### C8. Switches can only be tapped, not dragged. Low, Code
- **Where:** `public/style.css:306-319`. A `<button role=switch>` with no drag handling.
- **Native:** Settings switches can be slid, and the knob follows the finger.
- **Fix:** Use `<input type="checkbox" switch>`: native on iOS 17.4+ Safari, with drag and haptics, and it degrades to a checkbox elsewhere. Or add pointer tracking to the knob.

### C9. A 30-ride hold is 30 identical cards. Low, Reproduced (at 7 rides)
- **Where:** `public/app.js:557-564`.
- **Steps:** With a 7-ride hold, the Down tab is seven full cards, each with the same range, the same "From 82 past outages" line and the same bar. A 30-ride storm hold is about 6,500 px of repetition before the unrelated breakdowns.
- **Native:** Weather groups repeated alerts; Mail threads them.
- **Who and when:** Storm afternoons, the app's busiest moment.
- **Fix:** Show one hold card (range, count, elapsed) with a compact list of ride names as rows. Keep full cards for rides that aren't in a hold.

### C10. Pause options don't say when they end. Polish, Reproduced
- **Where:** `public/app.js:773-795`.
- **Steps:** "For 1 hour", "For 3 hours", "Until tomorrow morning" have no clock time. There is also no Cancel row, and no "Until I turn it back on", although the API supports `until: null`.
- **Native:** Focus and Do Not Disturb options show "Until 3:12 PM" and "Until tomorrow morning" with a time.
- **Fix:** Add each option's end time as a `row-detail` ("Until 3:12 PM", "7:00 AM"). Add a Cancel row. Consider "Until I resume".

## D. Feedback and state

### D1. Failed toggles can leave a switch showing what the server never saved. High, Reproduced
- **Where:** `public/app.js:92-107`. Each `save()` snapshots `before` and restores the whole `dash.trip`.
- **Steps:**
  1. Make PATCH fail after 800 ms.
  2. Toggle Mad Tea Party off, then Peter Pan's Flight off, 100 ms apart.
  3. After both fail, Peter Pan is back on, but **Mad Tea Party stays off**. The second rollback restored a snapshot taken after the first optimistic change.
  4. The server still follows Mad Tea Party. The guest believes they won't hear about it, and they will. The opposite order hides alerts they asked for.
- **Native:** A failed Settings change reverts exactly that control.
- **Who and when:** Anyone toggling a few rides on a flaky park connection.
- **Fix:** Roll back only the fields a save changed, and only if nothing newer has touched them. Better: serialize trip saves through one queue and re-read `trip` from the server after a failure. Add a test with two overlapping failures.

### D2. A server outage shows as "Offline" on a phone that is online. Medium, Reproduced
- **Where:** `public/app.js:1471-1480`. Any error that isn't a 404 sets `offline = true`.
- **Steps:** Make `/api/*` answer 502 (Railway's "Application failed to respond"). The header says "Offline · as of 2:10 PM", and a 429 would say the same.
- **Native:** Apps tell "You're offline" apart from "Can't reach the service".
- **Who and when:** During an outage or a bad deploy, guests toggle airplane mode and reboot phones that are fine.
- **Fix:** Use `navigator.onLine === false` or a network `TypeError` for "Offline". For a status of 500 or above, say "ParkAlert isn't responding · as of 2:10 PM". For 429, say "Busy, trying again shortly". Keep retrying in both cases.

### D3. "Everything's running" when the park is closed, or when offline. Medium, Reproduced and Code
- **Where:** `public/app.js:549-555`.
- **Steps:**
  - Offline launch with a cached list where nothing was down shows a large green check with "Everything's running" (screenshot `s7-offline-launch`).
  - After closing, the code renders "Everything's running" above "The park is closed for the day."
- **Native:** Weather says "Data as of 2:10 PM" and never presents stale data as current. A closed store in Maps says Closed.
- **Who and when:** Evening guests, and anyone opening the app with no signal.
- **Fix:** Pick the state first:
  - Closed: moon icon, "Park closed", "Opens 9:00 AM tomorrow".
  - Offline or stale: "Nothing was down as of 2:10 PM".
  - Otherwise: the green check.

### D4. A new deploy never tells the open app to reload. Medium, Code
- **Where:** `public/sw.js:7-17` (`skipWaiting`, `clients.claim`), `public/app.js:1683-1685`. No `updatefound` or `controllerchange` handling, and no version check against the API.
- **What happens:** A home-screen app kept in memory keeps running the old `app.js` against the new server until iOS kills it, which can be days. Any change to an API shape then breaks silently.
- **Native:** App Store apps update between launches. Well-behaved PWAs show "A new version is ready · Reload".
- **Fix:**
  - Have the server send `version` (the git sha or a build time) in `/dashboard`.
  - When it differs from the one the page loaded with, reload the next time the page is hidden, or show a small "Updated. Tap to reload" toast.
  - Also listen for `controllerchange`.

### D5. Pull to refresh gives no feedback when nothing changed or it failed; no pull on sheets. Medium, Reproduced
- **Where:** `public/app.js:1386-1429`.
- **Steps:** Pull on Down now: one dashboard fetch, the spinner, then nothing. There is no "Updated just now", even when nothing changed or the fetch failed (only the header meta changes, in small text).
- **Other gaps:**
  - Pull isn't wired on the setup screen or in any sheet.
  - The ride sheet's error tells the guest to "Pull down on the list to retry" (`:989`), and pulling down on a sheet closes it.
- **Native:** Mail shows "Updated Just Now" under the title after a pull, and an error line when it fails.
- **Fix:** After a pull, set the header meta to "Updated just now" for 3 s, or "Couldn't refresh" in orange. Give the ride and park sheets a Retry button instead of the pull instruction.

### D6. One toast slot: a second toast wipes an Undo; toasts cover sheet buttons. Medium, Reproduced
- **Where:** `public/app.js:111-119`, `public/style.css:417-431`.
- **Steps:**
  - Unfollow all ("Unfollowed every ride · Undo"), then toggle a ride that fails. The error replaces the Undo, and the only way back is gone.
  - With a sheet open, toasts sit at tab-bar height over sheet content (B4).
- **Native:** iOS never stacks transient banners over a modal's primary button. Undo stays reachable (shake to undo, or Mail's Undo bar, which waits its turn).
- **Fix:** Queue toasts; an Undo toast is never replaced, the next one waits. When a sheet is open, place the toast above the sheet's safe bottom or inside it.

### D7. Switching parks shows the old park with no sign anything is happening; its Undo can fail silently. Medium, Code
- **Where:** `public/app.js:813-827`.
- **What happens:**
  - After picking a park, the sheet closes and the old park's rides stay on screen until `PATCH` and a fresh poll return (up to 5 s server wait, plus 15 s client timeout).
  - Undo runs `await patchTrip(...)` with no `catch`. A failure is an unhandled rejection and no message.
- **Native:** Switching an account or location swaps immediately to a loading state for the new place.
- **Fix:** Put the new park's name in the header at once with "Loading rides…", and clear the lists. Wrap Undo in `try` with the same "Couldn't switch parks" toast.

### D8. "Alerts on" with zero rides followed. Low, Code
- **Where:** `public/app.js:403-411`. `alertState` ignores the follow list.
- **Steps:** Unfollow all. The header still says "Alerts on" with a bell.
- **Fix:** Add a state: bell-off, "No rides followed", which opens Rides.

### D9. Follow all has no confirmation or Undo; Unfollow all does. Low, Reproduced
- **Where:** `public/app.js:698-709`.
- **Fix:** Give both the same toast with Undo ("Following all 30 rides").

### D10. The ride sheet's switch doesn't roll back when the save fails. Low, Code
- **Where:** `public/app.js:1078-1081`. It sets `aria-checked` after `toggleFollow`; the rollback in `save()` re-renders the Rides list, not the sheet.
- **Fix:** Re-render the sheet's switch from `isFollowing` in `renderAll`, or have `save()` return and await the result.

### D11. No haptics anywhere a native app has them. Low, Code
- **Where:** The only haptic is `navigator.vibrate?.(8)` on pull to refresh (`:1423`), which iOS Safari doesn't support.
- **Native:** A tick on switch toggle, on pull-to-refresh arming, on sheet detents and on chart scrub steps.
- **Fix:** On iOS 17.4+, a hidden `<input type=checkbox switch>` toggled inside the gesture is the one reliable way to get a system tick. Use real `switch` inputs (C8) and the same trick for pull arming and scrub steps. Keep `vibrate` for Android.

### D12. Leaving a trip leaves its cached data and flags behind. Low, Code
- **Where:** `public/app.js:394-400`. `parkalert.dash.<code>` and `parkalert.alertsReady.<code>` stay.
- **Effects:** Rejoining briefly shows the old dashboard. On a shared phone, the topic stays in storage.
- **Fix:** Remove both keys on leave. Add a short toast, "Left trip A79UDR", with Undo.

## E. Charts and numbers

### E1. The scrub readout never resets after lifting the finger. Medium, Reproduced
- **Where:** `public/app.js:1325-1329`. The reset happens only on `pointerleave` for a mouse.
- **Steps:** Scrub the wait chart from 80% to 30% and lift. The readout still says "2:05 PM · 40 min wait" and the crosshair stays, until the next background refresh replaces the sheet at a random moment.
- **Native:** Stocks and Weather snap back to "Now" when the finger lifts.
- **Fix:** On `pointerup` and `pointercancel`, call `show(t1, false)`, with a short fade.

Scrubbing at the very left edge (x = 3) worked and clamped correctly.

### E2. "Last 7 days" shows Typical and Longest over the whole archive. Medium, Code
- **Where:** `server/insights.js:44-56`, `public/app.js:1124-1131`.
- **What happens:** "Outages" sums the 7 days shown, but `typicalMinutes` and `longestMinutes` come from every archived outage, up to a year. Today the archive is 7 days, so they agree. After a month, "Last 7 days · Longest 3 hr" can describe an outage from March.
- **Fix:** Compute typical and longest from the same 7 dates, or relabel the block ("All history").

### E3. Chart labels ignore text size; 30 day labels overlap. Low, Code
- **Where:**
  - `public/style.css:454`: ticks are `11px`, scaled by the SVG `viewBox`.
  - `public/app.js:1268`: the width takes off a fixed 32 px, but the box's padding is in rem.
  - `public/app.js:1378`: one weekday label per day.
- **What happens:**
  - At 200% text the axis labels stay tiny while everything else doubles.
  - With `THEMEPARKS_API_KEY` (30 days), 30 "Mon Tue…" labels share 329 px: about 11 px each, so they collide.
- **Fix:** Put tick labels in HTML with rem sizes, as `.chart-x` already is. Past 10 days, label only Mondays, or the first of each week, with dates.

### E4. Grouped "back up" pushes drop the durations single ones carry. Low, Reproduced
- **Where:** `server/poller.js:298-303`.
- **Steps:** The hold ended and the push was "5 rides are back up / Space Mountain, … / Magic Kingdom". A single ride says "Was down 12 min".
- **Fix:** Add "Down about 12 min" when the group shares a duration within a few minutes, which a hold always does.

### E5. Push times ignore the phone's 12/24-hour setting. Low, Code
- **Where:** `server/poller.js:81-87` (`'en-US'`) against `public/app.js:47` (the device locale).
- **What happens:** A phone set to 24-hour time reads "Went down at 2:10 PM" in the push and "14:10" in the app.
- **Fix:** Acceptable for a US park app, but then use `en-US` in the app too, so the push and the card always match.

### E6. The wait chart has no hour ticks and no zero. Low, Reproduced
- **Where:** `public/app.js:1278-1284`, `:1339`.
- **Steps:** The x axis has only the start time and "Now". The y axis has only the top value.
- **Native:** Weather's hourly charts label every few hours and put a baseline value.
- **Fix:** Add ticks every 2 hours along the bottom and a "0" at the baseline.

Relative times are live on the Down tab (a 15 s tick). In sheets they update only with the 30 s refresh, and the hold sheet not at all (A6). Times are shown in the park's zone everywhere I checked (cards, sheets, pause, push). The card, sheet and push share one outlook string, so the range agrees across all three at the moment of the push.

## F. Visual craft

### F1. At 200% text the header collapses to "Ma g…" and rows break. High, Reproduced
- **Where:** `public/app.js:430-441` (`fitTitle`), `public/style.css:173-192`.
- **Steps:** With a 200% root size at 393 px (screenshots `big-down`, `big-rides`):
  - The pill keeps its full width.
  - The title is squeezed to about 70 px and line-clamped mid-word ("Ma / g…").
  - "Open until 11:00 PM" wraps onto four lines.
  - On Rides, "FOLLOWING ALL 30" and "Unfollow all" each wrap to two lines.
  - Ride switches slide under the tab bar.
- **Native:** At accessibility sizes, iOS stacks: the large title takes the full width and trailing controls move below it or into a toolbar. `overflow-wrap: anywhere` never breaks a word.
- **Who and when:** Guests with larger text, often the parents and grandparents on the trip.
- **Fix:**
  - Above a threshold (say, when `fitTitle` hits its floor), move the pill onto its own line under the meta. Drop `overflow-wrap: anywhere`.
  - Let `.list-header` stack.
  - In rows, let the switch wrap below the label at accessibility sizes.

### F2. The icon and splash are purple. High (standing preference), Reproduced
- **Where:** `public/icons/icon.svg:7-8`, `maskable.svg`, `favicon.svg` (gradient `#120d38` to `#43208a` to `#b8327f`), and `public/manifest.webmanifest:9` (`background_color: #120d38`).
- **Steps:** The setup screen's first image is a violet-to-magenta sky. The Android splash is deep indigo.
- **Preference:** No purple anywhere in the interface.
- **Fix:** Redraw the sky in the app's own palette, for example a night blue (`#0b1e3a`) into a warm sunset orange. Set `background_color` to `#f2f2f7`, or to the icon's new top color.

### F3. Manifest theme is light-only; the splash color doesn't match either theme. Medium, Code
- **Where:** `public/manifest.webmanifest:9-10`.
- **What happens:** An installed Android app in dark mode gets a light `#f2f2f7` title bar over a black app. The splash is indigo in both themes, then flashes to the app's color.
- **Fix:** Keep the `<meta name=theme-color>` media pair as the source of truth, and pick a neutral splash (`#000` or `#f2f2f7`). Android doesn't support per-theme manifest colors yet, so a dark-neutral splash is the safe choice.

### F4. Install row uses the share glyph. Low, Reproduced
- **Where:** `public/index.html:162`.
- **What happens:** "Add to Home Screen" shows the same square-and-arrow as "Invite someone".
- **Native:** Add to Home Screen uses the plus-in-a-square glyph; share uses square-and-arrow.
- **Fix:** Draw an `i-add-square` symbol in the same stroke family. Keep the share glyph in the instructions sheet, where it points at Safari's button.

### F5. Wait chips orphan one chip on a second line. Polish, Reproduced
- **Where:** `public/style.css:405-411`.
- **Steps:** At 393 px with a 40 min wait, three chips fit on the first line and "30 min" sits alone on the second.
- **Native:** A segmented control or a single scrolling row.
- **Fix:** Use a one-row segmented control of 4 to 6 equal segments, falling back to a two-row grid at large text.

### F6. Recent outages list the time on some rows but not on holds. Polish, Reproduced
- **Where:** `public/app.js:1140-1143`.
- **Steps:** "Sun, Sep 27 · Park-wide hold" has no time. "Sat, Sep 26 · Went down at 5:02 PM" has one.
- **Fix:** Always show the time: "5:02 PM · Park-wide hold".

Checked and fine:
- **Safe areas:** landscape at 852×393 keeps content inside the 40rem column, clear of the notch; the tab bar respects the home indicator.
- **Dark mode:** text contrast is 6.6 to 8.4:1, and the light-mode text colours from audit 1 hold at 4.8 to 5.2:1. Chevrons are 2 to 2.8:1, which is decorative and matches iOS.
- **Divider insets:** match iOS, indented past the icon.
- **Reduced motion:** removes the view fade, press scaling and springs.
- **320 px:** nothing scrolls sideways, and the title shrinks to fit.
- **iPad:** the column is centered, but the sheet is a phone sheet stretched to 40rem. Acceptable.

## G. Words

### G1. Follow, alerts, watch and mute name one idea four ways. Medium, Reproduced
- **Where it shows up:**
  - Rides says "Following all 30", "Unfollow all" and "Not following".
  - The ride sheet says "Alerts for this ride".
  - The header says "Alerts on".
  - README line 13 says "watch list", and the API field is `watched`, alongside `rideMutes`.
  - The footnote says "The switch controls whether you get alerts about it."
- **Fix:** Pick one verb for the guest. "Alerts" is clearest: "Alerts for 29 of 30 rides", "Turn all off" and "Turn all on", with "Alerts for this ride" in the sheet. Rename in the README; keep the API names as they are.

### G2. The test push says "this phone" to every phone on the trip. Medium, Code
- **Where:** `server/index.js:287-295`.
- **What happens:** When one person taps Send test, their partner's phone buzzes with "Alerts are working on this phone."
- **Fix:** "ParkAlert test from your trip. If you see this, alerts reach this phone." Or name the trip: "Test alert for trip A79UDR".

### G3. Misleading or clumsy strings. Low, Reproduced

| Where | Now | Problem | Suggest |
|---|---|---|---|
| Trip tab, `app.js:719` | Pause alerts · **Off** | "Off" reads as "alerts are off" | Show nothing, or "Not paused" |
| Trip tab, `index.html:149-156` | PARK › Park · Magic Kingdom | Says "Park" twice | Section "Park", row "Magic Kingdom" with a chevron; or row "Change park" |
| Header, `app.js:453` | Updated 5 min ago · reconnecting | The phone isn't reconnecting; the server can't reach the ride feed | "Ride times may be out of date · 5 min" |
| Setup sheet, `app.js:902` | Sent. Send another | Two sentences in a button | "Send again" |
| Ride sheet, `app.js:1013` | Tell me when it is running with a wait of at most: | Long and stiff | "When it reopens, tell me if the wait is at most:" |
| Ride sheet, `app.js:1012` | It's 40 min now. Tell me when it's at most: | Two voices in one line | "Now 40 min. Tell me at:" |
| Toast, `app.js:1042` | We'll tell you when it's 30 min or less | "We"; elsewhere the app is "ParkAlert" in the third person | "Wait alert set for 30 min or less" |
| Ride sheet, `app.js:989` | Pull down on the list to retry | Pulling down closes the sheet | "Couldn't load history." plus a Retry button |
| Card foot, `app.js:953` | From 82 past outages at this park (on a hold) | The sheet says "82 past park-wide holds"; same number, different noun | "From 82 past holds at this park" |
| Weather rule, `predict.js:166-169` | Usually back in 30 to 45 min | From a rule, not history; "usually" overclaims | "Most rides reopen 30 to 45 min after a storm" |
| Down card, `app.js:499` | Delayed opening since 9:02 AM | A delay doesn't start at a time the guest cares about | "Hasn't opened yet · due 9:00 AM" |
| Rides row vs sheet vs card | "Down 3 min" / "Down for 3 min, since 2:04 PM" / "3 min" | Three phrasings | Pick one: "Down 3 min" everywhere, "since 2:04 PM" as detail |
| Long durations, `predict.js:204-208` | Usually back in 60 to 120 min | Past an hour, people say hours | "Usually back in 1 to 2 hr" (reuse `fmtDuration` rounding) |
| Setup footnote, `index.html:72` | Joining shares their rides and alerts. | "Shares" is ambiguous (with whom?) | "You'll see their rides and get the same alerts." |

### G4. Em dashes in two comments; emoji used as icons in the README and pushes. Low (standing preferences), Reproduced
- **Em dashes:** `server/index.js:279` and `server/poller.js:425`. They're comments, but the rule is no em dashes.
- **README:** the title is "ParkAlert 🎢", and lines 150-154 use 🔴 🟢 ⛔ ⏱️ as bullets.
- **Pushes:** they carry ntfy tags (`red_circle`, `green_circle`, `no_entry`, `stopwatch`), which ntfy renders as emoji at the front of each notification title. That's emoji used as icons in the one interface every guest sees most.
- **Fix:**
  - Replace both dashes with a colon or a comma.
  - Drop the README emoji.
  - For pushes, remove the tags. The title already says down, back up or closed. ntfy's app icon is the icon.

## H. Correctness (server)

### H1. A ride still down after a hold ends is quietly reclassified as a breakdown. High, Reproduced
- **Where:** `server/predict.js:102-116`. `classifyLive` counts only rides that are down now.
- **Steps:**
  1. Seven rides went down together: a hold, "Usually back in 25 to 50 min".
  2. Six reopened. The Walt Disney World Railroad, still down from the same storm, became a breakdown with "Usually back in 9 to 35 min · From 172 past outages" (screenshot `s8-down-recent`).
- **Effects:**
  - The estimate drops while the ride is still in the hold.
  - The kind tag disappears.
  - The weather path can stop applying.
- **Who and when:** The rides that take longest to come back after a storm, which are exactly the ones guests are waiting on.
- **Fix:** Store the live kind on the ride when it's first classified (`ride.kind`, set once per outage), and reclassify only upward (breakdown to hold, as more rides join). Test: a hold where all but one reopen keeps `kind: 'hold'`.

### H2. Park hours are fetched once a day and never re-checked. Medium, Reproduced
- **Where:** `server/poller.js:392-404`. It returns early whenever `schedule.date === today`.
- **Steps:** Change the fixture's close time mid-day and restart polling. The old hours stay until tomorrow. They also survive a restart, because `state.json` keeps them.
- **Effects:**
  - Disney often extends hours on the day. With an extension, alerts auto-mute at the old close while the park is still open.
  - With a same-day ticketed event added, party guests are muted.
- **Fix:** Refetch the schedule every 60 minutes, and in the hour before the known close. Keep the last good copy if a refetch fails.

### H3. A park day starts an hour off on daylight-saving days. Low, Code
- **Where:** `server/time.js:11-19`. It subtracts wall-clock time since midnight from `now`.
- **What happens:** On the November fall-back day, "today" starts at 1:00 AM, not midnight. On the March spring-forward day it starts at 11:00 PM the night before, so the ride sheet's "Today" can list the previous night's party-hour transitions. The test at `tests/insights.test.js:62` doesn't cover a DST date.
- **Fix:** Find midnight the way `nextLocalHour` does, by walking the offset. Add tests for 2026-03-08 and 2026-11-01.

### H4. Overnight "at least 13 hr" outages inflate Longest. Low, Code
- **Where:** `server/episodes.js:56-61`. A ride still DOWN at the end of history is censored at opening + 24 h.
- **What happens:** A ride that went down at 8 PM and was never switched to CLOSED is recorded as 13 hours. It then shows as "Longest 13 hr" and "at least 13 hr" in Recent outages. For the estimate that's correct (censored); for display it isn't.
- **Fix:** For display, cap censored episodes at that day's `lastCloseTime`, or leave them out of Longest and show "didn't reopen that day" without a number.

Checked and fine:
- Status transitions (down, up, late opening, closed while down and reopened within 8 h).
- Grouping by kind, per trip after mutes.
- Idle trips skipped.
- Mutes and pause.
- Ticketed-event close used for muting.
- Time zones seeded from the park list.

## I. Estimates

### I1. The scorecard and backtest only score rides that reopened. Medium, Code
- **Where:**
  - `server/scorecard.js:68-90`: CLOSED events are dropped, and calls that never resolve are forgotten after 12 h.
  - `server/backtest.js:50`: only `isResolved` episodes are scored.
- **What happens:** An outage that ends in "closed for the day" is always a miss for a "back in 10 to 40 min" range, and it's the miss guests remember. Leaving these out pushes "% in range" up. The park sheet then tells guests the estimates do better than they do.
- **Fix:** Score a close-for-the-day as a miss (actual = infinity), unless the text warned "About N% stay closed", in which case report it separately. Do the same in the backtest, with censored episodes counted as "at least", so a range that ends before the censor time is a known miss.

### I2. The backtest classifies with hindsight the live app doesn't have. Low, Code
- **Where:** `server/backtest.js:53` uses `ep.kind` from `classify()`, which sees rides that went down up to 10 minutes after.
- **What happens:** Live, the first rides of a hold are called breakdowns until five are down (`classifyLive`), and their first push quotes a breakdown range. The backtest scores those outages as holds from minute 0, which flatters the hold estimate. Holds also can't use the "all parks" pool in the backtest, which the live app uses.
- **Fix:** Rebuild the live view at each episode's start (rides already down at that moment) and classify from that. Pass every park's `past` so the pools match.

### I3. The scorecard scores unrounded ranges, not what guests were shown. Low, Code
- **Where:** `server/scorecard.js:20-31` against `server/predict.js:195-198`.
- **What happens:** The push says "10 to 40 min" (rounded to 5), and the score uses, say, 11.3 to 37.8. A reopen at 39 minutes counts as a miss for a range the guest read as a hit.
- **Fix:** Store the rounded lo and hi that `describe` produced, and score against those.

The weather adjustment itself reads correctly. Storm spells merge across both stations, the 15-minute lead is applied, and weather outages are taken out of the breakdown pool. The archive is too new for the backtest to mean anything yet, which is a known limit.

## J. Persistence

### J1. A corrupt trips.json is silently replaced with an empty one. Medium, Code
- **Where:** `server/store.js:11-17` (`load` returns the fallback on any error), `:19-24` (no `fsync`).
- **What happens:**
  1. A truncated or half-written `trips.json`, from a volume hiccup or a crash between write and rename on some filesystems, loads as `{}`.
  2. The first `saveTrips()` (any dashboard touch or trip creation) then writes `{}` over it.
  3. Every trip is gone. The phones show "Trip ABCDEF no longer exists" and leave.
- **Fix:**
  - On a parse error, rename the bad file to `trips.json.corrupt-<time>`, log loudly, and refuse to write trips until someone acts. At least never overwrite a non-empty file with `{}`.
  - `fsync` the temp file before renaming.
  - Keep one `trips.json.bak` per day.

### J2. Large files are rewritten synchronously on the poll thread. Low, Code
- **Where:** `server/store.js:52-60`, `server/weather.js:94`, `server/history.js:80`.
- **What happens:**
  - `weather.json` (a year of reports: about 44k observations, several MB) is rewritten on every 5-minute live refresh.
  - `history.json` (about 15 to 20 MB at a year) is rewritten once per fetched day, and again after pruning.
  - Each is a blocking `JSON.stringify` plus `writeFileSync`, 100 ms or more at size, during which polls and pushes wait.
- **Fix:** Write weather only when something new arrived. Move big writes to `fs.promises` with the same tmp-and-rename. Consider appending live reports to a small daily file.

### J3. Shutdown drops held alerts and in-flight pushes. Low, Code
- **Where:** `server/index.js:368-373`.
- **What happens:** `SIGTERM` flushes state and exits at once. Pushes mid-`fetch` are cut off. Alerts held by the cooldown (`held`, in memory) are lost, so after a redeploy inside 15 minutes the "last word is always right" promise can break.
- **Fix:** On SIGTERM, stop polling, `await` in-flight notifies (with a 5 s cap), then exit. Optionally persist `held` and `lastSent` in state.

File growth over a year is bounded: waits for 18 h, `recent` at 400, scores at 3,000, and history and weather at 365 days. `trips.json` grows forever (by design, trips are never deleted) and is pretty-printed, which is fine at family scale.

## K. Security

### K1. Per-IP limits key on the full IPv6 address, and one IP's typos lock out valid trips. Medium, Code
- **Where:** `server/ratelimit.js:48-55`, `server/index.js:181`.
- **What happens:**
  - A client on IPv6 gets a /64 and can rotate addresses freely, so the "miss" limit on guessing codes doesn't bind.
  - The miss check runs before a trip is looked up. Once one address has spent its misses, even the dashboard for a real trip answers 429 from that address.
  - Behind carrier NAT or park Wi-Fi, where many guests share one IPv4 address, one person's typos can lock out others. The client then shows "Offline" (D2).
- **Fix:**
  - Key IPv6 clients by /64.
  - Apply the miss wait only to lookups that miss (check `getTrip` first, and only meter when it fails), or exempt known codes.
  - Longer codes (8 characters) would make enumeration moot.

### K2. `/api/health` is public. Low, Code
- **Where:** `server/index.js:154-168`.
- **What happens:** It shows which parks have active trips, and raw upstream error messages. That's low sensitivity, but it's a free signal of when a family is at a park.
- **Fix:** Return only `ok` and ages publicly, or require a `HEALTH_TOKEN` query for detail.

Checked and fine:
- Every `innerHTML` built from API data goes through `esc()`, including ride names, event names and scorecard labels.
- The CSP blocks inline script.
- Codes and topics come from `crypto.randomBytes`.
- Input validation is complete, and prototype names are rejected.
- `/simulate` only reaches the caller's trip.

## L. Performance and cost

### L1. Phones poll the full dashboard every 30 s with no 304, even when the park is closed. Low, Code
- **Where:** `public/app.js:1505-1506`, `server/index.js:109-138`.
- **What happens:** Every open phone downloads every ride, with outlooks, twice a minute. That continues after close and, on desktop, in background tabs (the interval isn't paused when hidden; only the tick is). It's cheap on Railway, but it's cellular data and battery in the park.
- **Fix:**
  - Pause the refresh timer while `document.hidden`, and refresh on `visibilitychange`, which already exists.
  - After the last close, poll every 5 minutes.
  - Send a weak ETag on `/dashboard` (a hash of `lastPoll` and the trip's `updatedAt`) and answer 304.

Server cost is as the README says: estimates are indexed and cached, and polls are coalesced.

## M. Service worker across deploys

### M1. Network-first shell with no timeout. Medium, Code (not reproduced; see Suspected)
- **Where:** `public/sw.js:28-38`.
- **What happens:** A page load waits for the network before falling back to the cache. With no signal it falls back fast. On one bar that connects but barely moves data ("lie-fi", common in queues), the launch waits for the browser's own network timeout, which can be tens of seconds, before showing the cached app.
- **Native:** Apps open instantly from disk and refresh in the background.
- **Fix:** For navigations and app files, race the network against a 2 to 3 s timer and serve the cache when the timer wins, while still updating the cache in the background. Stale-while-revalidate for `/app.js` and `/style.css` pairs with the version check in D4.

## N. README

### N1. README claims that don't hold. Low, Reproduced
- **Line 144:** "Pull down on any list to refresh". Not in sheets or on setup (D5).
- **Line 156:** "Tapping an alert opens the app". It opens the home screen, not the ride (B1), and on iPhone likely Safari (R1).
- **Line 224:** "Header says reconnecting". Accurate, but the header wording itself misleads guests (G3).
- **Line 13:** "watch list". The app says "follow" (G1).
- **Line 27:** `npm install`. CI and the brief use `npm ci`, and the lockfile exists. Suggest `npm ci`.
- **Line 117:** "about 90 MB of RAM". Not re-measured here; it should say what it was measured on and when.
- **Lines 1 and 150-154:** emoji as icons (G4).
- The credit ("Built by Austin Vodrazka with Claude.") is present and joint. Its voice is fine.

## O. Tests that pass without testing much

### O1. Tests that pass without testing much, and missing ones. Low, Reproduced (read)
- **Weak tests:**
  - `tests/polling.test.js:50` asserts a constant's range; it tests the constant, not behavior.
  - `tests/notify.test.js:90` asserts `sent === 0` with no positive control in the same setup, so a broken setup that sends nothing also passes.
  - `tests/backtest.test.js:37-47` asserts only `n > 0` and `inRange > 0`.
  - `tests/insights.test.js:62` checks the park day start only on a normal day (H3).
- **Missing tests:**
  - Nothing covers the client beyond `time.js`: no test for the rollback race (D1), search normalization (C1) or sheet geometry.
  - Nothing covers `classifyLive` holding a kind through a hold's end (H1).
  - Nothing covers schedule refresh (H2).
- **Fix:** Add a positive control to the idle test. Replace the constant test with a behavioral one (a 20-minute gap starts afresh; a 3-minute gap doesn't). Extract `matchesSearch` and `rollback` as pure helpers and unit-test them. Add the H1, H2 and H3 cases.

---

## Suspected, not reproduced

- **S1. Lie-fi launch hang (M1).** Headless Chrome didn't apply the throttling to service worker fetches, so I couldn't time it. The code has no timeout.
- **S2. 20 px lag at drag start.** With the finger 100 px down, the sheet was at 80 px. That may be Chrome's touch slop rather than the app. The code itself is 1:1 from `pointerdown`.
- **S3. Scroll chaining behind the sheet.** A touch-scroll on the scrim may scroll the page behind on iOS. No body scroll lock is applied. Chrome didn't show it.

## Needs a real iPhone in standalone mode (unconfirmed)

- **R1. A push tap may open Safari, not the home-screen app. Likely High.** On iOS, a notification's click URL from the ntfy app opens in Safari. Safari's storage is separate from the home-screen app's, so the tap would land on the setup screen with no trip. Confirm on a phone. If so, the fix is a universal-link-like flow. Web Push (audit 1's F4) avoids it entirely, because the notification belongs to the PWA.
- **R2. Dynamic Type is ignored.** The root is `font: 100%`, and iOS applies the Settings text size to web content only through `font: -apple-system-body`. In a home-screen app there's no aA menu, so the rem layout likely never grows. Fix: `html { font: -apple-system-body }` with the scale derived from it.
- **R3. Press states in sheets.** iOS only applies `:active` when a touch listener is on an ancestor. `main` has one; the sheet layer is outside `main`, so sheet rows and buttons may get no touch-down feedback. Fix: `document.addEventListener('touchstart', () => {}, {passive: true})`.
- **R4. Pull to refresh against iOS bounce.** `overscroll-behavior-y: contain` keeps the native bounce. The custom pull translates `main` only after the first `touchmove`, so both may move for a few frames.
- **R5. Status bar in dark mode.** `apple-mobile-web-app-status-bar-style: default` gives a light status bar over the black dark-mode app. There's also no `apple-touch-startup-image`, so the iOS splash is blank white.
- **R6. Live refresh kills momentum.** `sheet.update` replaces content during a momentum scroll: iOS fires `pointercancel` once scrolling starts, which clears `touching`.
- **R7. Share and clipboard in standalone.** Invite uses `navigator.share`, and the topic uses `navigator.clipboard`. Both should work in iOS standalone mode, but the copy fallback toast ("Press and hold the topic") needs checking, since the code element scrolls sideways.
- **R8. Left-edge chart scrub in a Safari tab.** The back-swipe from the left edge competes with scrubbing (not an issue in standalone).
- **R9. The old app lingers after a deploy.** How long iOS keeps a home-screen app resident before D4 bites.

## Checked and fine (not findings)

- The first screen leads with an action ("Use my location", then the parks). No loud bordered banners anywhere. No purple in the interface CSS; only the icon and splash (F2).
- Tapping the current tab scrolls to the top.
- Offline launch shows the last rides, marked "Offline · as of", and recovers by itself when back online.
- A trip deleted or mistyped: the bad invite says so; a deleted saved trip leaves with a toast.
- A park with zero history says nothing rather than guessing. A six-hour outage says "Down longer than most outages here". A one-point wait chart draws a flat line to now.
- Light-mode text contrast from audit 1 still passes. Dark mode passes comfortably.
- No horizontal scroll at 320 px, and none in landscape.

## The 10 fixes I'd do first

1. **B1 and R1:** push taps open the ride or hold, and confirm on an iPhone whether taps open Safari; if they do, plan around it.
2. **A1 and A4:** drag sheets from anywhere, with native flick projection and zero velocity on a held release.
3. **A2 and A5:** back closes sheets, and stacked sheets get a back button.
4. **H1:** a ride keeps its hold classification until it reopens.
5. **D1:** exact rollback for overlapping failed saves.
6. **C1:** search that folds accents and apostrophes, drops "the" and matches words in any order.
7. **F1:** the header and rows at 200% text (and R2, honor Dynamic Type).
8. **F2 and G4:** remove purple from the icon and splash, drop emoji icons from pushes and the README, and remove the two em dashes.
9. **D2 and D3:** say "ParkAlert isn't responding" rather than "Offline", and never show "Everything's running" for a closed park or stale data.
10. **H2 and J1:** refetch hours during the day, and never overwrite a corrupt trips.json with an empty one.
