# ParkAlert audit

Date: 2026-09-28. Branch: `claude/relaxed-rubin-y01a6g` at `3c205b2`. Written before any code changed; the findings below are as found. The resolution table records what happened to each.

## Resolution

All findings were fixed, each in its own commit with tests where it made sense. Lint, tests (47 → 114) and a smoke run of the real app passed after every commit. Answers to the questions: the description is right; H4 holds alerts back instead of dropping them; the linter is ESLint 9 (dev-only; 10 would need Node 20.19+); colours and the title were changed; delayed openings say "now open, N min late"; a down ride that closes sends "has closed"; `/simulate` stays public but rate-limited; idle trips stop getting pushes and nothing is deleted.

| ID | Commit | | ID | Commit |
|---|---|---|---|---|
| H1 | `76aba65` | | L1 | `134893a` |
| H2 | `9159be2` | | L2 | `43d779f` |
| H3 | `cfc2dab` | | L3 | `4d83317` |
| H4 | `6d968a2` | | L4 | `61652d7` |
| M1 | `bbe8b6d` | | L5 | `05982a9` |
| M2 | `9785d72` | | L6 | `b8cc83d` |
| M3 | `624b202` | | L7 | `0a4355d` |
| M4 | `05782ce` | | L8 | `caef9e6` |
| M5 | `6e97fb6` | | L9 | `6b4d700` |
| M6 | `fe40611` | | L10 | `3335806` |
| M7 | `ad8646e` | | L11 | `da9ebd8` |
| M8 | `0cde60e` | | L12 | `5bd8986` |
| M9 | `bb1c61c` | | L13 | `8428058` (with the new icon) |
| M10 | `a93862e` | | L14 | `4d6ed3c` |
| M11 | `0ba42b1` | | L15 | `cbb2c9c` |
| M12 | `c189e0d`, plus tests in each fix | | L16 | `adfa4fb` |
| | | | L17 | `d450dd9`, `3a53c83`, `d9c0914`, `4acd0b8` |
| | | | L18 | `46bf7cf` |
| | | | L19 | `46093cd` (lint, private), `f59e72d` (CI) |
| | | | L20 | `828a4f6` |

Found while fixing, not in the audit:
- `/simulate` pushed to every trip at the park, not just the caller's (`c52374e`).
- The cooldown treated "never alerted" as "alerted at time zero" (fixed in `6d968a2`).

Improvements done: F2 "has closed" alert (`2ead0b9`), I1 offline last-known rides (`5e2a4ea`), I2 health (`46bf7cf`), I3 CI (`f59e72d`), I4 sort by shortest wait (`ac17714`), I6 park-clock times (`9785d72`), F6 Add to Home Screen (`1fa0d80`). Left for a decision: I5, F1, F3, F4, F5.

---

## What the app is (as I read it)

The goal prompt left the app description as a placeholder, so this is inferred from the code and README. **Please confirm or correct it.**

> ParkAlert is a mobile-first PWA for a small group (typically two phones on one "trip") visiting a Disney park. It sends a push through ntfy the moment a ride they follow goes down or comes back up. Down alerts include an honest reopen range estimated from past outages. The dashboard shows what is down, wait times, and per-ride outage history.

## Baseline

| | |
|---|---|
| Stack | Node 18+ with zero npm dependencies (`node:http`, built-in `fetch`); vanilla JS/CSS PWA with no build step; flat JSON files for storage; ntfy.sh for push; ThemeParks.wiki as the data source; deployed on Railway (Nixpacks, volume at `/data`). |
| Structure | `server/`: HTTP and API (`index.js`), 60s poller and alerting (`poller.js`), nightly history backfill (`history.js`), outage extraction (`episodes.js`), Kaplan-Meier estimates (`predict.js`), detail-sheet stats (`insights.js`), persistence (`store.js`). `public/`: one-page app (`app.js`, 1,350 lines), styles, service worker, manifest. `tests/`: `node:test` suites. |
| Run | `node server/index.js` (port 3000). No env vars required. |
| Tests | `npm test`: **47/47 pass** (0.6s). |
| Lint | **No linter is configured.** |
| Run check | The server starts cleanly. This sandbox's network policy blocks `api.themeparks.wiki`, so I ran the real server against a local stand-in for ThemeParks.wiki and ntfy, loaded with `--import` from my scratchpad; no repo files changed. With it I exercised trip creation, joining, the alert-setup sheet, test pushes, simulate, a real 6-ride park-wide hold arriving through the poller (it produced one grouped push per trip and respected each trip's follow list), and the ride, park and hold sheets. I also ran offline launch, a failed first dashboard load, keyboard navigation, malformed API input and an XSS-named ride, all in headless Chromium at 390×844. |

## Questions for you

1. **App description.** Is the summary above right?
2. **Anti-flicker cooldown (H4).** Today a repeat alert inside 5 minutes is dropped, which can leave phones believing the opposite of the truth. May I change "drop" to "defer": after the cooldown, send the latest state if it still holds? This changes documented behaviour.
3. **Delayed openings (L6).** A ride that never opened (CLOSED → DOWN → OPERATING) currently sends "X is back up, was down 40 min" with no "down" alert before it. Should that be "X is now open (40 min late)", or nothing?
4. **Rides that give up for the day.** DOWN → CLOSED sends nothing, so the last thing a phone heard is "X is down". Do you want a "X closed for the rest of the day" alert?
5. **Linter.** Phase 3 says to run the linter after each change, and there isn't one. Options: (a) a zero-dependency `npm run lint` using `node --check` on every file (syntax only), or (b) ESLint as a devDependency with a minimal flat config (real checks; runtime still has zero deps). I recommend (b). Which do you prefer?
6. **Rate limiting (M4).** Is an in-memory per-IP limiter (zero-dependency) acceptable? Should `/simulate` stay public, or only be enabled when an env var is set?
7. **Colours (M10) and title size (M11).** These touch your iOS-idiom design. May I darken the text-only colour variants in light mode (fills unchanged) and let the large title shrink to fit long park names?
8. **Idle trips (L8).** Should trips idle over 21 days also stop receiving pushes, and be deleted after, say, 90 days?

## Summary

| ID | Sev | Area | Finding |
|---|---|---|---|
| H1 | High | Alerts | Yesterday's park hours can mute every alert all day |
| H2 | High | Alerts | Phantom "back up, was down 18h" alerts after any gap in polling (park hop, restart, outage) |
| H3 | High | Offline | Opening the app with no signal strands you on the setup screen, even after signal returns |
| H4 | High | Alerts | Cooldown can drop the alert that tells you a ride went down again (design, see Q2) |
| M1 | Med | UX / errors | If the first dashboard load fails, the app shows blank or wrong state and most buttons throw |
| M2 | Med | Alerts | "Pause until tomorrow morning" after midnight silently pauses the whole next day |
| M3 | Med | API | Malformed input gives 500s with internal messages; PATCH stores any shape |
| M4 | Med | Security | No rate limiting; code enumeration and push spam can burn the server's shared ntfy quota |
| M5 | Med | Robustness | An empty or partial live snapshot wipes rides and resets outage clocks |
| M6 | Med | Data | Right after a park switch the dashboard shows the old snapshot as live |
| M7 | Med | Perf | Estimates rebuild the whole archive twice per call; cost grows with a year of history |
| M8 | Med | A11y | Keyboard and screen-reader focus is lost on every toggle and every refresh |
| M9 | Med | A11y | Sheets are not modal for keyboard or assistive tech (no focus trap, background not inert) |
| M10 | Med | A11y | Light-mode text contrast is below WCAG AA (design, see Q7) |
| M11 | Med | UI | The park name truncates on a standard phone ("Magic Kin…") (design, see Q7) |
| M12 | Med | Tests | No tests for the HTTP API, muting, cooldown, polling or history sync |
| L1–L20 | Low | Various | See below |

No critical issues. Nothing exposes secrets, and the XSS, path-traversal and prototype-pollution checks passed (see "Checked and fine").

---

## High

### H1. Yesterday's park hours can mute every alert all day
- **Where:** `server/poller.js:54-57` (`isPastClosing`), `server/poller.js:201-215` (`refreshSchedule`)
- **What's wrong:** After midnight, `refreshSchedule` tries to fetch the new day's hours. If that request fails, `state.schedule` keeps yesterday's hours. `isPastClosing` then compares now to yesterday's closing time, which is always in the past, so `isTripMuted` returns true for every ride on every trip. Alerts stay silently off until a schedule fetch succeeds. The client does the same (`app.js:341-348`) and tells the user "Park closed". Verified: `isTripMuted` returns `true` with a stale schedule.
- **Fix:** Only honour a schedule whose `date` is today in the park's zone. If it's stale or missing, fail open (don't auto-mute) and report "hours unavailable". Add a test.

### H2. Phantom alerts and wrong durations after any gap in polling
- **Where:** `server/poller.js:12-44` (`applyLiveData`), `server/poller.js:246-270` (`doPollPark`), `server/index.js:56-58`
- **What's wrong:** Ride state is persisted, and the next poll diffs against it however old it is. A park stops being polled when no trip is on it (park hopping, which the app explicitly supports), and state also goes stale after a server restart or an upstream outage. When polling resumes, every ride whose status differs produces an alert. Verified: a ride that was DOWN when a trip hopped away at 3pm yesterday and is OPERATING today generates **"Space Mountain is back up · Was down 18h"** the moment someone switches back. Rides that are still down show "Down 18 hr" and "longer than most outages", and `since` values are equally stale.
- **Fix:** If the previous snapshot is older than a threshold (about 10 min), take the new poll as a fresh baseline: no events, and reset `since`/`downSince`. Record `lastPoll` per snapshot for this. Add tests for both the park-hop and restart cases.

### H3. Opening the app with no signal strands you on the setup screen
- **Where:** `public/app.js:1302-1309` (`boot`), `public/app.js:1291`
- **What's wrong:** `boot()` fetches `/api/parks` first and, if that fails, shows the setup screen with an empty park list and "Check your connection and reload". A saved trip is ignored. Signal in parks is notoriously patchy, so this is a likely path. Verified in Chromium: offline launch showed the setup screen, and after coming back online it still showed the setup screen. The `online` handler refreshes the hidden trip view, not the screen the user is looking at. The comment at `app.js:1339` ("Offline at launch: keep the trip and show what we can") is never reached.
- **Fix:** If a trip code is saved, go straight to the app shell and treat `/parks` as lazy, since it's only needed for the setup and park-picker lists. Retry automatically on `online` and `visibilitychange`, and re-render the correct screen. Pairs well with the "cache last dashboard" improvement (I1) so the offline view shows real data.

### H4. The cooldown can drop the alert that says a ride went down again
- **Where:** `server/poller.js:67-80`, `server/poller.js:150-156`
- **What's wrong:** A repeat alert for the same ride and direction within 5 minutes is dropped, not delayed. Sequence: DOWN at t=0 (sent), UP at t=2 (sent), DOWN again at t=3 (**dropped**). If that last outage lasts an hour, every phone's last word is "back up", which is exactly what the app exists to prevent. The README documents the cooldown, so this is a design choice, which is why I'm flagging it rather than changing it (Q2).
- **Fix (proposed):** Keep the suppression, but remember the suppressed event. On the first poll after the cooldown, if the ride is still in that state, send one alert. Ride flapping still can't spam, and the final state is always delivered.

## Medium

### M1. If the first dashboard load fails, the app is blank or wrong and buttons throw
- **Where:** `public/app.js:1161-1178` (`refresh`), `public/app.js:1252-1283` (handlers), `public/index.html:81-83`
- **What's wrong:** When `dash` is null (server slow, a 5xx, or the network drops mid-launch), the trip code is blank. The header pill still says **"Alerts on"** because it's hard-coded in the HTML. Tapping the pill, "Alerts on this phone", "Invite someone", "Park" or the park title throws `TypeError: Cannot read properties of null`. Verified: 4 uncaught errors across 6 taps. The lists are empty with no loading or error state.
- **Fix:** Render a loading state until the first dashboard arrives, then an error state with a Retry button if it fails. Guard handlers that need `dash`. Start the pill as neutral ("Loading…") rather than "Alerts on". Show the trip code from `tripCode`, which is always known.

### M2. "Pause until tomorrow morning" after midnight silences the whole next day
- **Where:** `public/app.js:595-604`, `public/app.js:625-630`
- **What's wrong:** "Tomorrow" is `new Date()` + 1 day at 07:00 **in the phone's time zone**. Pausing at 00:30 after a late party night pauses until 07:00 the *day after* next: 30 hours, a full park day with no alerts. The toast only says "Alerts paused until 7:00 AM", so it's easy to miss. It's also wrong for anyone whose phone isn't set to park time, which the app otherwise handles ("times are shown in the park's own time zone").
- **Fix:** Compute the next 07:00 in the park's time zone (today's if it's still before 7am there). Include the day in the toast when it isn't today. Add a test for the date maths, extracted as a pure helper.

### M3. Malformed input gives 500s with internal messages; PATCH stores any shape
- **Where:** `server/index.js:31-47`, `93-99`, `112-128`, `148-171`, `230-233`
- **What's wrong:**
  - Invalid JSON returns **500** `{"error":"invalid JSON"}`. A body of `null` returns 500 `Cannot read properties of null (reading 'parkId')`, leaking internals.
  - `GET /api/trips/CODE/rides/__proto__` (or `constructor`) resolves to `Object.prototype` and 500s.
  - `PATCH` accepts `watched: [1, {"a":2}]`, `mute: {until: "tomorrow"}` and `rideMutes: [1,2,3]` and persists them as-is. Verified: all three returned 200 and were saved.
- **Fix:** Return 400 for bad JSON and non-object bodies. Validate PATCH fields: `watched` is null or an array of known-length strings, capped; `mute.until` is null or a finite number within a sane range; `rideMutes` is a plain object of booleans. Look up rides with `Object.hasOwn`. Generic 500 message to the client, details in the log. Add API tests.

### M4. No rate limiting on public endpoints
- **Where:** `server/index.js:93-99` (create trip), `176-190` (simulate, test); `server/store.js:68-86`
- **What's wrong:** Everything is unauthenticated by design (the trip code is the credential), but nothing is throttled:
  - `POST /api/trips` creates unlimited trips. Each one rewrites all of `trips.json` synchronously, and every real transition then fans out to every spam trip's topic.
  - `POST /test` and `/simulate` let anyone with a code send unlimited pushes.
  - Codes (31⁶ ≈ 887M) can be enumerated with no throttle.

  Every push leaves from the server's one IP, and ntfy.sh rate-limits per sending IP. A single abuser could get the server throttled and silently break alerts for everyone.
- **Fix:** A small in-memory token bucket per IP (zero-dependency): tight for trip creation, test and simulate; looser for reads; 404 lookups counted separately to slow enumeration. Return 429 with `Retry-After`. See Q6 on `/simulate`.

### M5. An empty or partial live snapshot wipes rides and resets outage clocks
- **Where:** `server/poller.js:12-44`, `server/poller.js:251-253`
- **What's wrong:** `applyLiveData` keeps only rides present in the latest response. If the API returns `liveData: []` (an upstream hiccup), every ride disappears from the dashboard and the Rides tab shows "Following all 0". If one ride is missing for a single poll, its `downSince` resets when it reappears, so a 45-minute outage later alerts "Was down 5 min".
- **Fix:** Carry forward rides missing from a snapshot for a few polls. Treat an empty or drastically shrunken snapshot as a failed poll (set `lastError`, keep state). Add tests.

### M6. Right after a park switch the dashboard shows the old snapshot as live
- **Where:** `server/index.js:56-58`, `server/index.js:150-159`
- **What's wrong:** PATCH kicks off `pollPark` without awaiting it. The client's immediate `refresh()` sees a `lastPoll` (possibly from yesterday) and returns that state straight away, so for up to 30 s the user sees yesterday's rides as currently down.
- **Fix:** In `dashboard()`, await the poll when the snapshot is older than about 2 minutes or a poll is in flight. The H2 baseline change covers the phantom-alert half.

### M7. Estimate cost grows with the archive
- **Where:** `server/predict.js:72-80`, `server/index.js:76-82`
- **What's wrong:** The `pools` object literal evaluates `everywhere()` (flatten plus filter of *every* park's history) for all three kinds on **every** call, including breakdowns, which never use it. The dashboard computes an estimate for every down ride on every request (each phone refreshes every 30 s). History keeps 365 days of all 6 parks in memory. Measured about **9 ms per estimate** at 60k episodes, which blocks the event loop on each call; during a hold that's about 10 rides × every phone × every 30 s.
- **Fix:** Build pools lazily. Pre-index episodes by `park → kind → ride` when history loads or changes. Optionally memoise the outlook per ride per poll, since it only changes when state changes.

### M8. Keyboard and screen-reader focus is thrown away constantly
- **Where:** `public/app.js:528-540` (`renderRides` via `innerHTML`), `550-559`, `1294-1299` (15 s tick re-renders the Down list), `1176` plus `223-229` (sheet body replaced every 30 s)
- **What's wrong:** Toggling a ride's switch re-renders the whole list, so focus jumps to `<body>` (verified). VoiceOver and keyboard users lose their place after every toggle. The Down list is rebuilt every 15 s and an open ride sheet every 30 s, which also resets focus, interrupts screen readers, and cancels a chart scrub in progress.
- **Fix:** Update rows in place, keyed by ride id: change text and attributes rather than replacing nodes. At minimum, restore focus to the same `data-id` after a re-render and skip sheet refreshes while the user is interacting with it.

### M9. Sheets are not modal for keyboard or assistive tech
- **Where:** `public/app.js:134-232`, `public/index.html:175-181`
- **What's wrong:** The sheet is `role="dialog" aria-modal="true"`, but Tab walks out of it into the page behind (verified), and the background isn't `inert`.
- **Fix:** Set `inert` on `#app` and `#setup` while a sheet is open, and remove it on close. That gives a focus trap and hides the background from assistive tech in one line. `inert` is supported in all current browsers.

### M10. Light-mode text contrast is below WCAG AA *(design, see Q7)*
- **Where:** `public/style.css:15` (`--label-2`), `19-21` (`--red`, `--green`, `--orange`), `183` (`.pill.paused`)
- **What's wrong:** Measured against the backgrounds they sit on: secondary text 3.6–3.8:1, orange warnings 3.5–3.9:1, green "Working" 3.1:1, red elapsed times 3.6:1, and the white "Paused" pill text on orange **2.2:1**. AA needs 4.5:1 for text this size. Dark mode passes (7.2:1). These are Apple's system colours, so the design is intentional; Apple's own apps have the same weakness.
- **Fix (if approved):** Add darker text-only variants in light mode (e.g. `--label-2` at 0.75 alpha, red `#d70015`, green `#1e7e34`, orange `#a35a00`, all measured at 4.6:1 or better on both backgrounds). Keep fills and dots as they are. Give the paused pill dark text, or a darker orange fill.

### M11. The park name truncates on a standard phone *(design, see Q7)*
- **Where:** `public/style.css:88`, `166-171`, `175-181`
- **What's wrong:** At 390 px (iPhone 14/15) the 34 px bold title plus the pill leaves room for "Magic Kin…". "Hollywood Studios" and "California Adventure" are worse. The title is the entry point to the park sheet, and it's the main "where am I" cue.
- **Fix:** Let the title scale down to fit (a `clamp()` font size, or step down when long), or put the pill on the meta line. I'd keep the large-title idiom and just let it shrink.

### M12. Test coverage misses the most important paths
- **Where:** `tests/`
- **What's wrong:** The algorithms (episodes, Kaplan-Meier, schedule parsing, grouping) are tested well. Untested:
  - Every HTTP route and its validation. `server.test.js` is misnamed: it tests schedule parsing and grouping, not the server.
  - `isTripMuted`, including the closing-time auto-mute, which is where H1 lives.
  - `cooldownOk` and the non-simulated notify path (H4).
  - `pollPark` end to end (H2, M5), `syncHistory`'s BUDGET/WINDOW/prune handling, `simulateTransition`, park switching restoring follow lists, the static server's path handling.
  - Estimates for `opening`.
  - Nothing at all on the client.
- **Fix:** Add tests alongside each fix above. Add an API test file that boots `server/index.js` on port 0 with fake upstreams, like `notify.test.js` already does for ntfy. For the client, extract pure helpers (pause time, formatting) to test them, and optionally add one Playwright smoke test as a devDependency if you're OK with that.

## Low

| ID | Where | What's wrong | Proposed fix |
|---|---|---|---|
| L1 | `server/index.js:31-47` | Over the 100 KB limit, `readBody` rejects but keeps buffering the stream, and answers 500 rather than 413. | Stop reading (`req.destroy()` after responding), return 413. |
| L2 | `server/index.js:26-29`, `195-220` | No security headers: no `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` or `frame-ancestors`. Escaping is currently correct, but CSP is the backstop. | Add a CSP (`default-src 'self'`; inline styles are used, so `style-src 'self' 'unsafe-inline'`) plus the other headers on every response. |
| L3 | `public/app.js:239-243`, README "Adding parks" | The client groups parks into resorts by **time zone**. Following the README to add a park in a new zone (e.g. Disneyland Paris) makes it invisible in the picker. One in an existing zone (Universal Orlando) is listed under "Walt Disney World". | Add a `resort` field to `server/parks.js`, group by it, update the README. |
| L4 | `server/poller.js:247` | A new park's state defaults to `America/New_York` until its schedule loads. If that fetch fails, California parks show NY times and NY day boundaries. | Seed `timezone` from `getPark(parkId).timezone`. |
| L5 | `public/app.js:341-361` vs `server/themeparks.js:62-81` | On a day with only a ticketed event and no regular hours, the server auto-mutes at the event's end but the client never says "closed" and shows "Hours unavailable". | Send `lastCloseTime` to the client and use the same rule on both sides. |
| L6 | `server/poller.js:30-40` | Delayed opening (CLOSED → DOWN → OPERATING) sends "is back up" with no prior "down". See Q3. | Per your answer to Q3. |
| L7 | `server/poller.js:165-169` | A grouped DOWN push uses the first ride's outlook, even if the group mixes a hold with a separate breakdown. | Use the outlook shared by the majority, or say "hold" only when all are in the hold. |
| L8 | `server/poller.js:159`, `server/store.js:92-103` | Trips idle 21+ days still get pushes when another trip keeps their park polled, and trips are never deleted. See Q8. | Skip inactive trips in `notifyTrips`; prune long-idle trips. |
| L9 | `server/poller.js:159-175`, `272-276` | Pushes go out one at a time per trip (15 s timeout each), and `pollAll` awaits them. A slow ntfy delays polling of the other parks. | Send each trip's pushes concurrently (`Promise.allSettled`) and don't block the next park's poll on delivery. |
| L10 | `server/poller.js:258`, `server/store.js:24-29` | The whole `state.json` (18 h of waits for every ride in every park) is pretty-printed and written synchronously on every park poll: 6 writes a minute with all parks active. | Write once per poll cycle, compact JSON. |
| L11 | `public/app.js:56-64`, `1161-1178`, `1290-1291` | Client requests have no timeout, and refreshes (timer, visibility, online, pull) can overlap and land out of order. | `AbortSignal.timeout` on fetches; skip or queue a refresh while one is in flight. |
| L12 | `public/sw.js:17-29` | Caches every GET response, including errors, and a new entry for every `/?join=CODE` URL. It also falls back to `/` for failed images. | Only cache `res.ok` responses for known static paths; strip the query for navigations. |
| L13 | `public/manifest.webmanifest:7-11` | Black splash and theme colour in light mode. The 512 icon is `"any maskable"` but has baked-in rounded corners and art near the edge, so Android masks will crop it oddly. | Separate `any` and `maskable` icons, the latter full-bleed with safe-zone padding. Add `id` and `scope`. |
| L14 | `public/index.html:77-80` | `<h1>` inside `<button>` is invalid HTML, and the heading isn't exposed to screen readers. | Put the `h1` outside and make the button wrap only the meta row, or use `aria-labelledby`. |
| L15 | `public/style.css:258`, `374` | "Follow all" and "Copy" tap targets are about 24–28 px tall, under the 44 px guideline. | Pad the hit area without changing the visuals. |
| L16 | `public/app.js:773-776` | Tapping a ride in "Most outages" that isn't in today's live list (renamed or seasonal) does nothing. | Open a history-only sheet, or don't render it as tappable. |
| L17 | Several | Code quality: `NTFY_BASE` defined twice (`index.js:54`, `notify.js:1`). Park-local date formatting written three ways (`history.js:24`, `poller.js:203`, `themeparks.js:64`). `APP_URL` lives in `poller.js` but configures the server. Shape comments in `store.js:31-44` are out of date (missing `downFrom`, `waits`, `recent`, `watchedByPark`, `lastSeenAt`). Dead `.option` CSS (`style.css:102`, `353`). Durations read "1h 5m" in pushes but "1 hr 5 min" in the app. `app.js` is one 1,350-line file. | Consolidate the constants and helpers into one `config`/`time` module and fix the comments. Optionally split `app.js` into native ES modules (still no build step). Not urgent. |
| L18 | `railway.json` | The health check hits `/api/parks`, a static list, so it passes even if polling has died. | Add `/api/health` reporting last successful poll per active park. I'd keep the Railway health check lenient so an upstream outage doesn't cause restart loops. |
| L19 | `package.json` | No lint script, no CI, no `"private": true` (so an accidental `npm publish` is possible), and `tests/*.test.js` relies on shell globbing (fails from Windows `cmd`). | `"private": true`; `node --test` (Node 21+ finds tests itself) or keep the glob; lint per Q5; a GitHub Actions workflow running lint and tests. |
| L20 | `README.md` | Solid overall. Gaps: the "~64 MB RAM" figure will drift as the archive grows toward a year; nothing on the test-without-network approach; no troubleshooting section (e.g. "Park closed" when it isn't, which is H1). | Refresh after the fixes land. |

## Checked and fine

- **XSS:** a ride named `<img src=x onerror=alert(1)>` rendered as text in every list and sheet, and no script ran. `esc()` is applied consistently.
- **Static path traversal:** `URL` normalises `..`, and the `startsWith(PUBLIC_DIR)` guard holds.
- **Prototype pollution:** `getTrip` upper-cases codes, so `__proto__` can't match. `JSON.parse` creates own properties.
- **Secrets:** none in the repo. Trip codes and topics come from `crypto.randomBytes`; the modulo bias over a 31-letter alphabet is negligible.
- **File writes** are atomic (write to tmp, then rename). Concurrent polls of a park are coalesced.
- **Grouped pushes and per-trip follow filtering** worked end to end in the run.

---

## Recommended improvements (not fixes)

- **I1. Cache the last dashboard on the phone** (localStorage), so an offline launch shows the last known rides with an "as of 3:42 PM" banner instead of nothing. Natural companion to H3.
- **I2. `/api/health`** with poll freshness per park, for uptime monitoring (L18).
- **I3. CI:** a GitHub Actions workflow running lint and tests on every push.
- **I4. Rides tab sorting and filtering:** by wait time, "down only", and hide closed or refurb rides.
- **I5. Show "Updated 12 s ago"** in the header when not stale, so people trust the list.
- **I6. Park-local "tomorrow" and date-aware toasts** everywhere a time crosses midnight (generalises M2).

## New feature ideas

- **F1. Wait-time alerts:** "tell me when Seven Dwarfs drops under 30 min". The single most common ask in park apps, and the data is already polled every minute.
- **F2. "Closed for the day" alert** when a down ride goes to CLOSED (Q4).
- **F3. Per-phone mute and follow list** without touching the ntfy app. Today everything is shared across the trip.
- **F4. Web Push as an alternative to ntfy.** No second app to install; iOS 16.4+ supports it for home-screen PWAs. Large change: VAPID signing plus a push handler in the service worker, and either a dependency or hand-rolled crypto. Would need your call.
- **F5. More resorts** (Universal Orlando, Disneyland Paris, Tokyo). ThemeParks.wiki has them; needs L3 first.
- **F6. "Add to Home Screen" guidance in the app**, not just the README, since the full-screen experience depends on it.

## Proposed order once approved

1. H1 and H2 (plus M6), with tests. Server-only, small, and they stop wrong or missing alerts.
2. H3 and M1, the client's offline and failed-load paths.
3. H4, per your answer to Q2.
4. M2, M3, M5 and L1 with API tests; then M4 (rate limiting).
5. M7 (perf), then M8 and M9 (a11y).
6. M10 and M11 if approved; then the Low items you want.
7. Improvements and features you pick, then the README.

Nothing here requires changing the stack or architecture. The biggest single change is M8 (in-place rendering of the Rides list), which I'd keep minimal.
