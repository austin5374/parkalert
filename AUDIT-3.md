# ParkAlert audit 3: why it feels glitchy

Date: 2026-09-28. `main` at `12f717a`. Reviewed by reading all of `public/app.js` (2,504 lines), `style.css`, `index.html` and `sw.js`, and by reproducing the main findings in Chrome. Benchmark: the WDW transport app (`~/disney-transport-app`).

## Root causes (confirmed)

1. **The UI is rebuilt from scratch on timers.** Every 15 s `renderHeader()` and `renderDown()` replace their DOM (`replaceChildren` and `innerHTML`); every 30 s `renderAll()` does the same for every tab, and open sheets are rebuilt too. Verified: the Down card and the alerts pill are new elements after one tick. Effects: taps that land mid-rebuild do nothing, press states cut out, focus and scroll can jump, and any in-progress CSS transition restarts.
2. **Switches can't animate.** Toggling one ride calls `save()`, which calls `renderAll()`, which rewrites all ~70 Rides rows. Verified: the switch element is gone after a toggle, so the knob jumps instead of sliding. With the "alerts on" filter the row disappears mid-tap.
3. **The tab bar jumps when a sheet reaches full height.** `recede()` puts `transform: scale()` on `#app`, and a transform on an ancestor breaks `position: fixed` and `sticky` inside it. Verified: the tab bar moved from y=662 to y=248, and the sticky header is affected the same way.
4. **Rich detail lives in a stack of hand-built sheets.** Detents, history `pushState` bookkeeping (`skipPops`, `entryAfterPop`), and separate pointer and touch drag systems (`sheet`, lines 254-560) sit in about 300 lines of fragile code. The transport app puts detail on pushed pages with a back chevron and a URL per screen, and keeps sheets for small single-purpose tasks. That is the structural fix.
5. **The header re-fits itself every 15 s.** `fitTitle()` resets the font size, then shrinks it 1 px at a time, re-measuring each step (a forced layout per step), on every tick and resize.
6. **Pages and scripts can come from different versions.** `sw.js` races network against cache per file (3 s). On slow park Wi-Fi the page can be cached while `app.js` is fresh, or the reverse, after a deploy.
7. **Nothing is compressed.** `app.js` is 110 KB, `style.css` 31 KB and the page 18 KB, all sent without gzip or brotli. Cold starts on a weak cell signal are slow.
8. **Content pops in.** There's a text "Loading…" instead of skeleton placeholders (the transport app uses skeletons), and each tab fades in over 180 ms whenever it's shown.

## What to take from the transport app (interaction, not style)
- Stack navigation: tap a ride and a Ride page slides in from the right, with a back chevron and a URL (`/ride/:id`). The back button and deep links work for free.
- Sheets only for quick choices: pause, park, leave, invite. One level, never stacked.
- Keyed, stable rendering: refresh updates text in place and never replaces rows.
- Skeleton placeholders on first load, and an honest "Updated 3:05 PM" line.
- Problems pinned to the top of the list, with filters as tabs with badges.

## Recommended plan
1. Rebuild the client's rendering layer: keyed rows updated in place (or adopt a tiny library such as Preact or lit-html), and no timer-driven full rebuilds. Tick only the elapsed-time text.
2. Replace ride, park and hold sheets with pushed pages and real routes; keep one simple sheet for short actions; delete `recede`.
3. Fix `fitTitle`, give the service worker one versioned cache (all files from one version), turn on compression, and add skeletons.
4. Re-test on a real iPhone from the home screen after each step.


## Resolution

All eight root causes are fixed on branch `ux-rebuild`. Each was re-checked in Chrome after the change.

| # | Fix | Checked |
|---|---|---|
| 1 | `morph()` patches the DOM in place, keyed by `data-key` (and `data-ride` and `data-id`, with the attribute kept in the key) | Down cards, the pill, ride switches, page switches and the wait chart all survive ticks, saves and refreshes |
| 2 | Same patcher; switches keep their element, so the CSS slide runs | The switch element is the same node after a toggle |
| 3 | The page-recede transform on `#app` is gone | The tab bar stays at the bottom with pages and sheets open |
| 4 | Ride, park and hold details are pages: slide in, back chevron naming the previous screen, `/ride/<id>`, `/park` and `/hold` addresses, Back, and swipe from the left edge. The sheet keeps short tasks only | Three stacked pages unwind by Back and by the chevron; a sheet over a page closes first; the address returns to `/` |
| 5 | `fitTitle()` only runs when the title, pill label, width or text size changes | |
| 6 | Service worker: one cache per version, filled whole at install, served as a set. A new version waits for Reload or for the app to be put away | |
| 7 | Static files are served from memory, gzipped | `app.js` goes from 110 KB to 35 KB on the wire |
| 8 | Skeletons while loading; tabs switch instantly | |

Found and fixed during the second pass:
- The Rides tab stacked two full-width segmented controls. Sort is now a toggle beside search.
- "Shortest wait" listed shows and walk-throughs (no posted wait) first. Rides with a posted wait now come first.
- Under "With alerts", switching a ride off made its row vanish from under the finger. It now stays until the filter, the search or the tab changes.
- Switching trips with a page open left the old trip's ride on screen. Pages now close first.
- An animation left running while the app was hidden never finished, because frames don't run. Motion now lands at once while the app is hidden.

The server features were read for correctness (wait alerts, schedule, estimates) and are covered by the existing tests. No new server defects were found.
