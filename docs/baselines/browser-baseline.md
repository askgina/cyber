# Live browser baseline

Baseline for [issue #4](https://github.com/t-y-b-b/breach-ledger/issues/4), measured on [cyber.askgina.ai](https://cyber.askgina.ai/) on 2026-11-25 UTC.

- **Accessibility:** 16 of 20 axe-core scans reported violations. Text contrast failed in all four configurations of Terminal, Leaderboard, Report, and the open incident drawer. Dark mode also had one label-in-name failure in each of those views at both widths.
- **Keyboard:** The skip link does not reach the active view's content. Enter on the sampled Terminal row opens and immediately closes its drawer. The command palette did return focus to its opener.
- **Network:** Each initial load transferred about 4.05 MB across 18 requests. The two same-origin JSON files accounted for 85.9% of those bytes. The audit tabs logged no console errors, uncaught page errors, or failed requests.

## Scope and method

- Used the `eval` browser API with managed headless Chromium 150. Desktop used a 1440 × 900 CSS-pixel viewport at device pixel ratio 1.25. Mobile used a 390 × 844 CSS-pixel viewport at device pixel ratio 1, with mobile layout and touch emulation. Both used the same desktop Chromium user agent. This was not a physical-device or screen-reader test.
- Injected axe-core **4.14.1** from `../askgina-blog/node_modules/axe-core/axe.min.js` into each audit tab. Ran `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })` after `document.fonts.ready` and after the requested view or overlay became visible. These tags cover the automated WCAG 2.0 and 2.1 A and AA rules in this build, not all WCAG criteria.
- Started in light mode and used the visible `.t-theme` button for dark mode. Used the view links for `#terminal`, `#leaderboard`, and `#report`. Opened the same Terminal incident, `#e-n-9456adfe`, from `#t-hit .t-r[data-id="n-9456adfe"]` in all four configurations. Audited Terminal underneath the open drawer, not the separate Leaderboard drawer.
- Opened `dialog#pal` from the Terminal filter with `Ctrl+K` (the non-Mac equivalent of `⌘K`). Audited the open, empty-query palette. The URL remained `#terminal`. Here `#pal` is the dialog ID, not the hash used to open it.
- Recorded whole-document results. The drawer leaves the background active, so its totals can include Terminal nodes. The native modal palette makes the background inert. Live data, scroll position, and the animated ticker can affect which nodes axe can evaluate. Use the same states for comparisons, and do not treat a scan with no violations as a conformance result.

## Automated accessibility results

Each cell lists **violation ID shorthand and exact failing node count**. All three reported IDs had axe impact **serious**, at both rule and node level. `None` means zero violations, not zero items for manual review.

| Key | Exact axe-core violation ID | Axe impact | WCAG criterion |
| --- | --- | --- | --- |
| HF | `aria-hidden-focus` | serious | 4.1.2 Name, Role, Value (A) |
| CC | `color-contrast` | serious | 1.4.3 Contrast (Minimum) (AA) |
| LN | `label-content-name-mismatch` | serious | 2.5.3 Label in Name (2.1 A) |

| View or state | Desktop light | Desktop dark | Mobile light | Mobile dark |
| --- | --- | --- | --- | --- |
| Terminal (`#terminal`) | HF 1, CC 3 | HF 1, CC 3, LN 1 | HF 1, CC 3 | HF 1, CC 3, LN 1 |
| Leaderboard (`#leaderboard`) | CC 9 | CC 9, LN 1 | CC 9 | CC 9, LN 1 |
| Report (`#report`) | CC 1 | CC 1, LN 1 | CC 45 | CC 45, LN 1 |
| Incident detail (`#e-n-9456adfe`) | HF 1, CC 3 | HF 1, CC 3, LN 1 | CC 3 | CC 3, LN 1 |
| Command palette (`dialog#pal` open) | None | None | None | None |

### Failing selectors and contrast

| Rule | Where | Sample axe selector | What axe measured |
| --- | --- | --- | --- |
| `aria-hidden-focus` | Terminal at both widths, plus the desktop drawer state | `.t-run[aria-hidden="true"]` | One flagged container, not one button. It contained 18 cloned ticker buttons in the keyboard spot check. Tab reached the first clone at both widths. |
| `color-contrast` | Terminal and incident drawer state | `.hx > span:nth-child(1)` | Three Terminal chart labels in each scan, including when the drawer was open. |
| `color-contrast` | Leaderboard | `.chip:nth-child(2) > i` | Nine category chip counts in each scan. |
| `color-contrast` | Report, both widths | `.hint` | The hint below the Report opening actions. This was the only desktop Report contrast failure. |
| `color-contrast` | Report, mobile only | `#hours > .axis > span:nth-child(2) > span:nth-child(1)`, `#series > .axis > span:nth-child(2) > span:nth-child(1)`, `#e-n-0755dc11 > .main > .more > .cnt` | In addition to `.hint`, axe flagged 3 hourly axis labels, 4 series axis labels, and 37 entry counts in each mobile Report scan. |
| `label-content-name-mismatch` | Dark Terminal, Leaderboard, Report, and drawer state at both widths | `#term > .t-top > .t-theme[aria-label="Dark mode"]` (also `#board > .t-top > .t-theme[aria-label="Dark mode"]` and `#rep > .t-top > .t-theme[aria-label="Dark mode"]`) | The visible text changed to **Light**, but the accessible name stayed **Dark mode**. One theme button failed per scan. |

Every confirmed `color-contrast` node used the same failing `--faint` color pair for its theme. The required contrast was **4.5:1** in all cases.

| Theme | Foreground | Background | Measured ratio |
| --- | --- | --- | ---: |
| Light | `#8c8581` | `#ffffff` | **3.62:1** |
| Dark | `#6e6e6e` | `#0a0a0a` | **3.88:1** |

### Incomplete results: manual review, not violations

Axe also returned `incomplete` results. All the rule entries below had impact `serious`. `AP` = `aria-prohibited-attr`, `CC` = `color-contrast`, `HF` = `aria-hidden-focus`, and `SR` = `scrollable-region-focusable`. Numbers count nodes marked for review, not confirmed failures.

| View or state | Desktop light | Desktop dark | Mobile light | Mobile dark |
| --- | --- | --- | --- | --- |
| Terminal | AP 3, SR 5 | AP 3, SR 5 | AP 2, CC 2,420, SR 4 | AP 2, CC 2,420, SR 4 |
| Leaderboard | AP 2, CC 14 | AP 2, CC 14 | AP 2, CC 391 | AP 2, CC 391 |
| Report | AP 2 | AP 2 | AP 2, CC 19 | AP 2, CC 16 |
| Incident detail | AP 3, SR 5 | AP 3, SR 5 | AP 2, CC 2,420, HF 1, SR 4 | AP 2, CC 2,420, HF 1, SR 4 |
| Command palette | CC 2 | CC 2 | CC 2 | CC 2 |

In the mobile drawer state, axe moved the ticker clone from a confirmed `aria-hidden-focus` violation to manual review. That result does not show that the background ticker became keyboard-safe.

## Keyboard, focus, and landmarks

These spot checks used trusted keyboard and pointer input and the Chromium accessibility tree on both viewport sizes in light mode.

| Area | Observation |
| --- | --- |
| Skip link | The first Tab exposed `a.skip` ("Skip to content") with a visible outline in all three base views. Enter changed the hash to `#term` and left focus on `body` with Report active, even when starting in Terminal or Leaderboard. The next Tab reached the Report "Cyber" brand link, not `main#main` or the active view's content. |
| Terminal navigation | `/` focused `#t-q`. `j` and `k` moved among rows. Tab reached `.t-run[aria-hidden="true"] button.t-ti` at both widths. The focused clone was partly outside the viewport in the mobile check. |
| Incident row activation | On the sampled `div[role="button"]` row, Space did not open the drawer. Enter activated the row and moved focus to `#t-ix`, then the same keystroke activated `#t-ix`. The event trace showed the drawer closing and focus returning to the row before keyup. The final hash was `#terminal`. A pointer click opened it reliably. |
| Drawer focus and semantics | When opened by pointer, focus moved to the "Close detail" button (`#t-ix`). Escape closed the drawer and returned focus to the originating row. Shift+Tab from `#t-ix` reached the underlying market panel `#t-mkt` at both widths. The drawer is an `aside` exposed as the "Incident detail" complementary landmark, not a modal dialog. It measured 600 × 900 on desktop and covered the 390 × 844 viewport on mobile. Background focus was still possible on mobile. |
| Palette focus and semantics | `Ctrl+K` moved focus from `#t-q` to `#pal-q` in the native dialog named "Search and commands". The combobox controlled `#pal-list`. Arrow Down changed `aria-activedescendant` from `pal-o0` to `pal-o1` without moving DOM focus to the option. Tab reported `body` between visits to the input, then wrapped to `#pal-q` on the next Tab. It did not reach Terminal controls. Escape closed the dialog and returned focus to `#t-q`. |
| Palette discoverability | There was no visible pointer or touch opener. The Terminal footer showed the desktop `Ctrl K` hint but was hidden at mobile width. The mobile scan used an emulated keyboard, not a touch-only opening path. |
| Heading hierarchy | Terminal and Leaderboard had no exposed headings. Their panel labels used text spans rather than heading elements. The sampled drawer exposed an `h2` title followed by an `h4` for "Coverage timeline (2 outlets)", with no `h1` or intervening `h3`. Report exposed one `h1`, ten `h2`s, and twelve `h3`s at each width. |
| Landmarks | Terminal and Leaderboard exposed the `Views` navigation and named panel regions, but no `main` landmark. Report exposed `main#main`, `Sections` and `Views` navigation, and named regions. Its `Contents` complementary landmark was desktop-only. The palette exposed a dialog, combobox, and listbox, with the Terminal landmarks absent from the open modal's accessibility tree. |

## Initial page transfer and errors

Measured one new navigation to `/` per viewport and theme, with the browser HTTP cache disabled through Chromium DevTools Protocol (CDP). These are single samples, not averages. The browser and CDN could reuse connections or have warm edge caches. The request window includes requests started in the first **8,000 ms** and excludes later interactions and polling. The local axe injection did not produce a network request.

**Bytes** are CDP `Network.loadingFinished.encodedDataLength` (received response transfer, not decoded size or upload size). Durations run from `requestWillBeSent` to `loadingFinished`, rounded to milliseconds. Document TTFB, DOMContentLoaded, and load event end are from Navigation Timing, measured from navigation start. Do not substitute Resource Timing `transferSize` for the CDP byte column: the latter also captured the WOFF2 files and cross-origin JSON responses.

| Initial navigation | Start (UTC) | Requests | Transfer (B) | TTFB (ms) | DOMContentLoaded end (ms) | Load end (ms) | Last response finished (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop light | 10:36:41.351 | 18 | 4,045,622 | 30 | 256 | 263 | 5,797 |
| Desktop dark | 10:40:59.346 | 18 | 4,045,932 | 46 | 191 | 193 | 5,607 |
| Mobile light | 10:37:00.635 | 18 | 4,045,491 | 39 | 199 | 200 | 5,733 |
| Mobile dark | 10:41:07.661 | 18 | 4,045,142 | 25 | 149 | 150 | 5,596 |

Each row below represents **one request per navigation**. Each measurement cell is **bytes / duration in ms**. Relative paths are same-origin. All requests were `GET` except the `POST /e` beacon.

| Resource | HTTP | Desktop light | Desktop dark | Mobile light | Mobile dark |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/` | 200 | 6,626 / 34 | 6,711 / 29 | 6,603 / 34 | 6,603 / 24 |
| `/styles.css?v=20261124-2315` | 200 | 10,133 / 39 | 10,161 / 31 | 10,133 / 45 | 10,133 / 28 |
| `/app.js?v=20261125-0210` | 200 | 17,137 / 44 | 17,165 / 40 | 17,149 / 52 | 17,137 / 32 |
| `/term.js?v=20261125-0200` | 200 | 9,639 / 33 | 9,671 / 26 | 9,681 / 46 | 9,639 / 33 |
| `/board.js?v=20261124-1700` | 200 | 4,513 / 35 | 4,541 / 27 | 4,513 / 44 | 4,513 / 31 |
| `/track.js?v=20261125-0320` | 200 | 1,325 / 38 | 1,354 / 32 | 1,326 / 45 | 1,325 / 26 |
| `/palette.js?v=20261125-0300` | 200 | 3,295 / 60 | 3,323 / 28 | 3,307 / 57 | 3,295 / 32 |
| `fonts.googleapis.com/css2` (Geist, IBM Plex Mono, Instrument Serif) | 200 | 964 / 48 | 964 / 20 | 964 / 38 | 964 / 21 |
| `fonts.gstatic.com` IBM Plex Mono `-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2` | 200 | 14,675 / 11 | 14,675 / 6 | 14,675 / 13 | 14,675 / 19 |
| `fonts.gstatic.com` IBM Plex Mono `-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2` | 200 | 14,931 / 20 | 14,931 / 8 | 14,931 / 15 | 14,931 / 24 |
| `fonts.gstatic.com` Geist `gyByhwUxId8gMEwcGFU.woff2` | 200 | 29,429 / 19 | 29,429 / 10 | 29,429 / 12 | 29,429 / 13 |
| `fonts.gstatic.com` Geist `gyByhwUxId8gMEwSGFWfOw.woff2` | 200 | 16,541 / 8 | 16,541 / 5 | 16,541 / 5 | 16,541 / 7 |
| `fonts.gstatic.com` Instrument Serif `jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjg.woff2` | 200 | 21,061 / 21 | 21,061 / 9 | 21,061 / 12 | 21,061 / 25 |
| `/data.json` | 200 | 2,490,594 / 563 | 2,490,394 / 579 | 2,490,492 / 561 | 2,490,159 / 464 |
| `/archive.json` | 200 | 984,953 / 310 | 985,224 / 273 | 984,891 / 330 | 984,953 / 327 |
| `/e` (beacon) | 204 | 30 / 53 | 30 / 18 | 30 / 27 | 30 / 16 |
| `api.llama.fi/hacks` | 200 | 206,453 / 21 | 206,445 / 19 | 206,454 / 27 | 206,445 / 20 |
| `haveibeenpwned.com/api/v3/breaches` | 200 | 213,323 / 750 | 213,312 / 750 | 213,311 / 756 | 213,309 / 750 |

- The five scripts together transferred **35,909 to 36,054 B**. Google Fonts transferred **97,601 B** across one stylesheet and five WOFF2 files in each sample.
- `/data.json` and `/archive.json` fetched on the default Terminal view without user interaction. Their request starts, in milliseconds from the first request, were **190 / 254** on desktop light, **126 / 174** on desktop dark, **172 / 192** on mobile light, and **134 / 148** on mobile dark. Resource Timing reported decoded bodies of **8,990,264 B** and **4,376,913 B**, respectively, in all four samples. The HIBP fetch finished last in each sample, well after the document load event.
- The four initial-navigation traces had **0 failed requests**: 17 responses were HTTP 200 and the beacon was HTTP 204 in each. Across the two matrix tabs, the browser recorded **79 requests per tab** through the final capture. Neither tab had a request marked failed, an HTTP 4xx/5xx response, a console error, or an uncaught page error. The manual keyboard tabs also logged no console or page errors. Some request records in those tabs had no terminal status during the repeated navigations and were not used to calculate the initial-load totals.

## Comparison checklist for Maps 2 and 3

1. Rerun the same 20 states. Compare rule IDs and node counts, then check the reported selector families and both `--faint` pairs against 4.5:1. Do not count incomplete checks as passes.
2. Verify by keyboard that Skip to content reaches the active view, the cloned ticker contributes no hidden tab stops, and Enter opens the drawer without closing it. Check whether focus can reach covered content at mobile width. Recheck Escape focus return for both overlays and a touch-only way to open the palette.
3. Repeat the cache-disabled transfer window. Compare `/data.json` and `/archive.json` request count, start time, and transferred bytes before looking at total bytes. Keep console exceptions, HTTP errors, and network failures separate from timing changes.
