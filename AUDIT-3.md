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

## Not yet done
- No code changed. Findings 1-3 were reproduced in Chrome; 4-8 come from reading the code and measuring.
- Not yet reviewed in depth: the server-side changes from PRs #1-#5 (weather, scorecard, wait alerts), accessibility, and the full CSS.
