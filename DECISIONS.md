# Hope Ave Fuel — Project Handoff

A personal web app that shows real-time gas prices for major-brand stations near
60 Hope Ave, Waltham, MA, on an interactive map. Built iteratively in Claude.ai;
handing off to Claude Code to continue.

## What this is, in one paragraph

A single-page app with a Leaflet map background, custom price-tag pins for 7
real gas stations (Shell + Mobil) within ~2.5 miles of home, a compact toolbar
(fuel grade + brand filters), hover/tap cards with full price breakdowns, and
off-screen direction indicators. Right now **all prices are hand-written sample
data** — nothing is live yet. That's the next milestone.

## Current file

`index.html` — the working prototype. Originally a single self-contained file
(HTML + CSS + JS inline, copied directly from the Claude.ai conversation); since
split for modularity into `index.html` + `styles.css` + `data.js` + `services.js`
+ `app.js`. Still **no build step and no server** — plain `<script>`/`<link>`
tags and relative paths (not ES modules), so it opens directly in any browser.
See `README.md` for the per-file breakdown.

### The `services.js` boundary (external-data adapter)

All calls to the outside world go through **`services.js`** (`window.FuelServices`):
`getHomeStations()`, `geocode()`, `findStationsNear()`. This is deliberately the
*single* file that knows which backend is live. Today they wrap the sample-data
fixture (`data.js`) and the keyless OpenStreetMap services; each has a
`TODO(google)` marking exactly what to replace to go live with Google — without
touching `app.js` or the UI. `app.js` reads external data only through this
interface and **injects** its domain helpers (the `classifyBrand` registry
matcher and `distMi`) via `FuelServices.configure()`, so the brand registry and
its colors stay in the UI layer. The data interface is **async** end-to-end
(`app.js` `boot()` awaits `getHomeStations()`), so the eventual Google swap is a
function-body change, not a control-flow change. The one external dependency
*not* behind this boundary is the Leaflet basemap, which is woven through
`app.js` (see the Google Maps JS note under "What's NOT done yet").

## Decisions already made (don't re-litigate these without reason)

- **Radius: ~2.5 miles** from 60 Hope Ave, Waltham, MA 02453. Chosen after
  mapping the area — this radius captures a balanced 3 Mobil / 4 Shell mix.
  Tighter radii (1–1.5 mi) were rejected for being too Mobil-heavy.
- **Brands: Shell and Mobil only.** "Exxon" was explicitly considered and
  dropped — the nearby Mobil stations *are* the Exxon-Mobil brand, there's no
  separately-branded Exxon nearby. Independents and other brands (Speedway,
  Haffner's, etc.) were deliberately excluded — major-brand-only was the call.
- **The 7 stations** (real coordinates, real Google Maps links):
  1. Mobil — Moody St (0.45 mi)
  2. Mobil — 821 Main St (0.70 mi)
  3. Shell — 962 Main St (0.75 mi)
  4. Mobil — 1335 Main St (1.35 mi)
  5. Shell — 65 Main St (1.85 mi)
  6. Shell — Waverley Oaks Rd (2.20 mi)
  7. Shell — Totten Pond Rd (2.30 mi) — sample data has this one with *no*
     price entries on purpose, to exercise the "no data" UI state honestly.
- **Default fuel grade: Premium.** Diesel was removed from the UI entirely
  (button removed, dropped from the active grade list) per explicit request —
  raw diesel sample prices are still sitting in the data objects, harmless,
  easy to resurrect if ever wanted back.
- **Map engine: Leaflet**, not the Google Maps JS API — by choice, specifically
  *so the basemap renders inside the Claude.ai artifact preview sandbox*,
  which blocks some external tile hosts. (An early parallel Google Maps JS API
  build existed but has since been deleted — it diverged too far to be worth
  reconciling. If a pixel-true Google basemap is ever wanted, rebuild it from the
  current `index.html` rather than resurrecting that old file. See "What's NOT
  done yet".)
- **Fonts: Poppins**, replacing an earlier Bricolage Grotesque + Martian Mono
  pairing, per explicit request.
- **Light mode only** — dark mode was built first, then explicitly replaced.
- **No bottom sheet.** A draggable bottom sheet existed and was explicitly
  removed; all per-station detail (full grade breakdown, freshness, open/closed,
  Navigate link) now lives in the hover/tap card on each map pin instead.
- **Hover-to-open on desktop, tap-to-open on touch** — detected at runtime via
  `matchMedia('(hover: none), (pointer: coarse)')`. This split exists because
  hover has no equivalent on touch devices; built deliberately, not a bug.
- **No brand icons in the toolbar filter buttons** (removed per request — text
  only: "All 7 / Shell 4 / Mobil 3"). Brand logos (via Simple Icons CDN, with a
  generic pump-icon fallback if that CDN is blocked) **are still used inside
  the hover/tap popup** on each pin, to help identify the exact station.

## Location search (added after the original handoff)

- **Goal:** type any location → see gas stations near it; the card's location
  name and the map both update; the home/locate button returns to the original 7.
- **Keyless OpenStreetMap, by choice.** Geocoding uses Nominatim
  (`nominatim.openstreetmap.org`), nearby stations use Overpass
  (`overpass-api.de`, `amenity=fuel` within ~4 km). Both are keyless and send
  `Access-Control-Allow-Origin: *`, so they work straight from `file://` with no
  proxy and no build step. This was the deliberate call over Google Places: the
  handoff already forbids exposing a Google key in the browser, and Google needs
  a serverless proxy that isn't built yet. **Both calls live in `services.js`**
  (`geocode()` / `findStationsNear()`), not `app.js` — see the `services.js`
  boundary note above.
- **Searched stations have no prices.** OSM knows *where* stations are, not their
  fuel prices, so searched stations carry `fuelPrices: []` and render in the
  existing "no data" (`N/A`) state — the same path `shell-totten` exercises. This
  is honest, not a bug. The objects returned by the search are shaped *exactly*
  like `getStationData()` output, so when the Google `fuelOptions` proxy is added
  it can populate `fuelPrices` and prices appear with zero UI changes.
- **Brand registry + multi-select filter.** A curated `BRANDS` registry (in
  `app.js`) defines the "major" brands — currently **Shell, Exxon/Mobil,
  BP/Amoco, Chevron/Texaco, Phillips 66** — each with a label, accent color, and
  OSM tag aliases (matched with word boundaries so e.g. "bp" doesn't hit mid-word).
  `classifyBrand()` maps each search result to a registry brand or `other`.
  To change which brands are "major", just edit `BRANDS` — the filter UI and
  pin/chip colors are derived from it.
  - The toolbar brand control is a **multi-select checkbox group** (`#brandFilter`).
    **Every registry brand plus `Other` is always shown** (the fixed `FILTER_KEYS`
    set, registry order, `Other` last), in *every* location — the registry is the
    source of truth, so the options must be consistent. A brand with no stations in
    the current radius just shows count **`0`** (it's not hidden). This was a
    deliberate correction of an earlier version that built the list only from
    brands present in the result set, which made the control's options jump around
    per location. Replaced the old single-select Shell/Mobil segmented buttons.
    Note: the search already fetches *all* `amenity=fuel` in radius and classifies
    each, so every brand is genuinely considered — only the UI needed fixing.
  - A leading **"All" master toggle** selects/clears every group at once (all
    majors + `Other`). It renders checked when all are on, indeterminate when only
    some are, unchecked when none — kept in sync as individual brands toggle
    (`syncAll()`). Because `Other` is off by default, "All" sits at *indeterminate*
    in the default state, which is the honest reading (not everything is selected).
  - **`Other` (independents/unbranded) is off by default** — this is the fix for
    "search shows too many junk stations". Majors start checked; the user can tick
    `Other` to reveal the rest. If an area has *only* independents, `Other` is
    auto-selected so the map isn't blank.
  - `state.brand` (string) became `state.brands` (a `Set`); `visible()` filters by
    membership. Brand accent color is applied via an inline `--brand` CSS var on
    each pin/edge-chip, with CSS falling back to neutral for `other`.
- **Origin marker is now dynamic.** The single home-pin became `renderOrigin()`:
  a house icon at home, or a blue teardrop at a searched / current-location place.
  `DATA` is the *active* set on screen (home, search, or "near me"), populated
  asynchronously at `boot()` from `services.js` — there is no longer a fixed
  `HOME_STATIONS` array; `homeOrigin()` derives the home point from the saved
  `localStorage` home (or the Waltham seed). The `PAD` constant centralizes the
  toolbar padding used for framing/edge-chips, bumped up because the card is taller.
- **Politeness / limits.** Search fires on submit only (not per keystroke). If a
  host is ever slow/blocked, the search surfaces a transient error toast and keeps
  the current set.

## Home location & current-location detection (added later)

- **Home is settable and saved per-device, not hardcoded.** Waltham is no longer
  special — it's just a default *seed*. The user's home lives in `localStorage`
  (`fuelHome` = `{lat,lng,label,full}`), set by typing an address into the **✎
  editor** (geocoded via the Google proxy). The top **home chip** is **disabled
  until a home is set**, then shows the place name and jumps there on click.
- **Per-device by design — no accounts, no backend.** `localStorage` is scoped to
  each browser+device, so different people on different devices automatically get
  independent homes for free. Deliberate tradeoff: it's **per-browser**, not synced
  across a single user's devices, and is lost if they clear site data. True
  cross-device, per-account sync would require sign-in + a database — intentionally
  out of scope for a personal app.
- **"Stations near me"** (the bottom-right button, repurposed from the old
  "back to home"): browser-native `navigator.geolocation` (free, no key) →
  `findStationsNear()`. Needs **HTTPS** (Vercel) + a one-time permission grant;
  desktop accuracy is Wi-Fi/IP-based (rougher), mobile is GPS-accurate. Denied/
  unsupported → honest toast, current view kept.
- **First-open default = current location.** With no saved home, `boot()` requests
  the device location and opens to **stations near you**; if denied/unavailable it
  falls back to the Waltham seed. Returning users with a saved home open straight
  to it (no prompt). This was an explicit choice for the multi-user case — defaulting
  everyone to Waltham would be meaningless for non-local users.
- **All external calls still go through `services.js`.** Added `getCurrentPosition()`
  (device) and `reverseGeocode()` (for a friendly "near me" / set-home label, via the
  proxy's new `latlng` param). The brand registry/colors stay injected from `app.js`.
- **Cost note:** geolocation is free; only the reverse-geocode label touches Google
  (negligible, and the `/api/stations` cache is the real cost lever). See "What's NOT
  done yet" / the cost guardrails below.

## Known non-obvious implementation details (read before touching these)

- **Hover-card interaction (dwell-to-open + grace-to-close bridge).** This was
  rebuilt several times; the current design is deliberate — read before touching.
  Hover open/close is bound to the visible `.ptag` chip (via `mouseenter`/
  `mouseleave`), NOT Leaflet's bubbling `mouseover`/`mouseout`.
  - **Open after a ~130ms dwell** (`HOVER_OPEN_MS`) so quick fly-bys over
    neighbouring pins don't strobe popups open/closed.
  - **Close after a ~260ms grace** (`HOVER_CLOSE_MS`); entering the popup CARD
    cancels it, so the cursor can travel from the pin onto the card to read it /
    click NAVIGATE. Closes only when the cursor leaves both.
  - **Pointer-events are load-bearing:** the popup CARD (`.leaflet-popup-content-wrapper`)
    is `pointer-events:auto` (so the bridge + NAVIGATE work), but the popup TIP and
    outer box are forced `pointer-events:none!important` — the tip overlaps the chip
    and, if interactive, steals the hover and reintroduces flicker. The marker icon
    box is also `none` (only the chip is interactive) so adjacent pins' invisible hit
    boxes don't overlap. `autoPan:false` on the popup so opening never moves the map.
  - A `[BUG]` logging pass proved the earlier "map jumping" was actually this popup
    strobing (the map never moved). Don't reintroduce instant-close-on-leave.
- **Off-screen direction indicators.** Any visible station whose pin falls
  outside the safe viewport (excluding the toolbar's footprint) gets a small
  arrow chip clamped to the nearest edge, pointing toward it, clickable to fly
  there. Recomputed on every map move/zoom *and* on filter change. The angle
  math (`Math.atan2`, then `+90°` to orient the arrow glyph) was reasoned
  through carefully but **never visually confirmed** by the human — if a
  fresh session touches this, sanity-check the rotation direction against a
  known station before assuming it's correct.
- **Locate/recenter button.** Bottom-right, fixed icon (currently a filled
  navigation-arrow glyph approximating iOS Google Maps' style — this was done
  from memory, not a live reference, and may need correcting against the real
  app). Clicking it computes the zoom level that fits all 7 stations (same
  method `fitBounds` uses internally) but **centers on the home pin specifically**,
  not the bounds' midpoint, with a manual pixel-offset correction for the
  toolbar's footprint. This was an explicit, deliberate tradeoff: centering
  home can mean stations aren't evenly margined anymore.
- **Crossfade animation on filter change.** Switching grade/brand fades the
  old pins out (~160ms) then fades the new set in (~220ms) — see `drawMarkers()`
  vs `renderMarkers()`; the latter is the crossfade wrapper, the former does
  the actual draw. Initial page load skips the fade (no pins exist yet to fade
  out from).
- **The vector "fallback" road drawing.** There's a hand-traced GeoJSON of
  local roads (Main St, Moody St, Waverley Oaks, Totten Pond Rd, I-95, Charles
  River) that only renders if *every* real tile host fails to load. It exists
  purely as a safety net for the in-preview sandbox blocking tile CDNs — it is
  not meant to be the primary basemap and shouldn't be polished further.

## What's NOT done yet (the real next milestones)

1. **Live data.** The sample prices (`data.js` `getStationData()`) are shaped to
   exactly match Google Places API (New)'s `fuelOptions` response format
   (`{type, price, updateTime}` per grade, per station) — this was intentional,
   so swapping in real data is contained to **`services.js`**: replace the bodies
   of `getHomeStations()` / `findStationsNear()` (and `geocode()`) — each marked
   `TODO(google)` — to call your proxy, keeping the return shapes. `app.js` and
   the UI don't change; the interface is already async.
   To actually wire this up:
   - Get a Google Maps Platform API key with **Places API (New)** enabled
     (field mask: `fuelOptions`).
   - **Do not call Google's API directly from the browser** — the key would
     be exposed. Build a small serverless proxy (Vercel function or
     Cloudflare Worker) that holds the key server-side, calls Place Details
     for the 7 station Place IDs, and returns JSON in the same shape.
   - Real fuel-price refresh cadence: Google updates this data roughly daily
     itself, not continuously — polling more than a few times a day won't
     produce fresher numbers, just wasted quota. A few times a day, plus
     on-app-open, is the sane default. This was already discussed and agreed
     upon earlier in the build — don't over-engineer real-time polling.
   - Need each station's real Google Place ID (not currently in the file —
     only lat/lng and a `maps.google.com/?cid=` link are stored).
2. **Google Maps JS API basemap (optional, not currently needed).** An early
   parallel build (`Gas Price-google.html`) ported the UI onto the real Google
   Maps JavaScript API for a pixel-true Google basemap, but it was shelved (it
   won't render without a key) and has since been **deleted** — it had diverged
   too far from `index.html` (brand filter, freshness stamp, `N/A` state, pin
   labels, hover fixes, the `services.js` data layer) to be worth reconciling.
   **For current progress and needs this is not required:** the live Google
   *data* (prices + search) now flows through the `services.js` proxy while the
   Leaflet basemap stays, and Leaflet with the light CARTO tiles reads very close
   to Google. If a pixel-true Google basemap is ever wanted, treat it as a fresh
   build *from the current `index.html`* (porting markers/popups/edge-indicators
   to Advanced Markers + InfoWindow/OverlayView, and re-solving the hover
   behavior on Google's terms) — not a resurrection of the old file.
3. **Real Map ID / cloud styling**, if going the Google Maps route — currently
   uses a placeholder `DEMO_MAP_ID`, fine for testing Advanced Markers, but
   you'll want your own Map ID for custom styling.
4. **Cost/quota guardrails** — set a budget alert in Google Cloud Console
   before going live with a real key, even though expected usage (7 stations,
   a few refreshes/day, personal use) is comfortably within free tiers for
   both Maps JS API (10k loads/mo free) and Places API.

## Files in this handoff

- `index.html` — current Leaflet-based prototype (this IS the app right now)
- `styles.css` — all UI styling
- `data.js` — sample-data fixture (`window.FuelData`)
- `services.js` — the single external-data boundary (`window.FuelServices`);
  the one file to edit to go live with Google
- `app.js` — UI + logic; reads external data only via `window.FuelServices`
- `api/geocode.js`, `api/stations.js` — Vercel serverless proxy to Google
  (Geocoding + Places `fuelOptions`); keeps the API key server-side
- `DECISIONS.md` — this file
- `DATA-SHAPE.md` — the exact data contract `getStationData()` must return,
  so a live-data implementation matches what the UI already expects

## How to verify you haven't broken anything

Open `index.html` directly in a browser (no build step, no server needed).
Check: map renders with real street tiles, 7 pins appear, hovering a pin
(or tapping, on touch) shows its full card including a working Navigate
link, switching Grade/Brand crossfades the pins, the locate button
recenters on home, and any station that's off-screen at the current
zoom shows a directional arrow chip at the edge.
