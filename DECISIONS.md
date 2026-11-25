# Hope Ave Fuel — Decisions & How It Works

A personal web app that shows live gas prices for stations near you (or any place
you search) on an interactive map. Started as a hand-written prototype for 60 Hope
Ave, Waltham, MA; now runs on live Google data for any location.

> Last synced to the code: **2026-11-24**. The previous version of this file (as of
> July 2026, describing the OpenStreetMap / sample-data era) is kept in
> `docs-archive/DECISIONS-2026-07.md` for history.

## What this is, in one paragraph

A single-page app: a Leaflet map (CARTO Voyager street tiles, Esri as backup) with
price-tag pins for
gas stations within a chosen radius (0.5–5 mi, default 2.5) of the current
*origin* — your saved home, your device location, or a searched place. Prices,
open/closed state and place search come **live from Google** through a small
serverless proxy on Vercel. A floating toolbar holds the search bar, grade picker,
brand filter, and radius slider; hovering (desktop) or tapping (touch) a pin opens
a card with all grades, freshness, and a Navigate link. Stations that are
off-screen or hidden behind the toolbar get arrow chips at the screen edge.

**Live deployment:** `https://gas-price-app-nu.vercel.app` (verified working
2026-11-24 — the proxy returned same-day Google prices).

## Architecture

No build step, no ES modules, no framework. `index.html` loads, in order:
Leaflet (CDN) → `data.js` → `services.js` → `app.js`.

| Layer | File | Responsibility |
|---|---|---|
| Markup | `index.html` | Map container, search bar, toolbar card, home chip + gear button, "near me" button, set-home modal |
| Styling | `styles.css` | All styles; font-size tokens in `:root`; one mobile breakpoint at `max-width:640px` |
| Constants | `data.js` | `window.FuelData` = `{ NOW, HOME, getStationData }`. Only `NOW` (page-load timestamp) and `HOME` (Waltham seed point) are used. `getStationData()` is the old sample fixture — **unused**, kept as reference |
| Data boundary | `services.js` | `window.FuelServices` — the **only** file that makes network calls. Converts proxy results into the app's station shape |
| App logic | `app.js` | Map, tiles, pins, popups, edge chips, filters, radius, search, home, boot. Reads data only via `FuelServices` |
| Proxy | `api/stations.js`, `api/geocode.js` | Vercel serverless functions that call Google with the server-side key |
| Dev tool | `_selfcheck.js` | UI invariant checker; not loaded by the app (see below) |

### The `services.js` boundary

All outside calls go through `window.FuelServices`:

- `geocode(q)` → `GET /api/geocode?q=` → `{lat, lng, label, full}` or `null`
- `reverseGeocode(lat, lng)` → `GET /api/geocode?latlng=` → same shape or `null`; never throws
- `findStationsNear(lat, lng, radiusM)` → `GET /api/stations?lat=&lng=&radius=` → station array sorted by distance
- `getCurrentPosition()` → browser geolocation (free, no key) → `{lat, lng}`; rejects with the browser error (`code 1` = permission denied)
- `getHomeStations()` → stations around the Waltham seed. **Not called anywhere** (leftover)
- `configure({classify, distMi})` → `app.js` injects the brand classifier and distance function so the brand registry and its colors stay in the UI layer

`toStation()` in `services.js` builds each station: brand from `classify({name})`
(Google's display name only), distance from the **current origin** (not from home),
a Google Maps link using the Place ID, and `fuelPrices` passed through unchanged.

### The proxy (`api/`)

- **Key:** read from the `GOOGLE_SERVER_KEY` environment variable on Vercel. Never
  sent to the browser.
- **`/api/stations`** calls Places API (New) `places:searchNearby` with
  `includedTypes: ['gas_station']`, `maxResultCount: 20`, a circle of the requested
  radius (capped at 50 km), and the field mask
  `places.id,displayName,location,fuelOptions,currentOpeningHours`. Prices are
  converted from Google's `{units, nanos}` to a number. Response cached at the edge:
  `s-maxage=86400, stale-while-revalidate=86400`.
- **`/api/geocode`** calls the Geocoding API with `address=` (search) or `latlng=`
  (reverse). `ZERO_RESULTS` → `null` (200). Any other non-OK status (e.g.
  `REQUEST_DENIED`) → 502 with Google's status and `error_message`, so key/billing
  problems are visible rather than looking like "no results". Cached a day
  (+7 days stale-OK). Builds a short "Street, City" label from address components.
- **Cost:** `fuelOptions` is in Google's most expensive Places pricing tier. The edge cache is
  the main cost control — don't remove it. Google refreshes fuel prices roughly
  daily, so polling more often gains nothing.

## Decisions (don't re-litigate without reason)

- **Map engine: Leaflet with raster street tiles, not the Google Maps JS API.** The
  basemap has never been Google. Originally chosen so the map rendered inside the
  Claude.ai preview sandbox; CARTO Voyager was the preferred look because it reads
  close to Google. Google is used for **data only**. A pixel-true Google basemap is
  optional — see "Not done yet".
- **CARTO now needs a key (since Sept 2026).** Without a valid key, CARTO answers
  every tile request — HTTP 200 — with the same "API KEY REQUIRED" watermark image;
  a wrong key gets the same image. Keys are free for personal / non-commercial use
  (5M tiles/month) from https://carto.com/basemaps/apikey. Paste it into
  `CARTO_KEY` near the top of the tiles section in `app.js`. The key is necessarily
  visible in the browser (CARTO's terms forbid proxying tiles), so lock it down with
  the restrictions in CARTO's dashboard. Attribution "© OpenStreetMap contributors,
  © CARTO" is required and already set. **A key was added on 2026-11-24** (Voyager
  verified loading on localhost). If `CARTO_KEY` is ever emptied, CARTO is skipped
  and the map uses Esri. Keyed Voyager tiles stop at **zoom 18** (z19+ returns 403),
  so the CARTO style's `max` is 18 — raising it blanks the map when zoomed in fully.
- **Tile fallback chain:** CARTO Voyager (only if `CARTO_KEY` is set) → Esri World
  Street → OpenStreetMap (softened with a CSS filter) → a hand-traced vector drawing
  of Waltham roads. Two guards decide when to move down the chain:
  1. **Placeholder check (`servesPlaceholder`)** — before using a host, fetch two
     tiles that differ on any real map (z0 world vs one z1 quadrant). Identical
     bytes → the host is serving a placeholder (missing/invalid key) → skip it and
     log a `[tiles]` warning. Added 2026-11-24 after the CARTO change slipped past
     guard 2 and tiled the watermark across the map. If the check can't run
     (network error), the host is used and guard 2 decides.
  2. **Tile errors** — a host is abandoned after 3 tile errors before any tile loads.
  If no tiles load within 4.2 s, a badge explains the fallback. The vector drawing is
  a safety net only — don't polish it.
- **Live data only, never fake prices.** If the proxy fails at startup the map is
  left empty with a "Couldn't load live prices" toast. The sample fixture is never
  shown as if it were live.
- **Default grade: Premium.** Grade buttons: Reg / Mid / Prem. Diesel was removed
  from the UI by request (`GORD` excludes it), but Google's `DIESEL` entries stay in
  the data, harmlessly.
- **Radius slider:** 0.5–5 mi in 0.1 steps, default 2.5 mi (a green tick marks the
  default and the value turns green at it). Re-fetches once on release, not while
  dragging. **Not persisted** — every page load starts at 2.5 mi.
- **Brand registry** (`BRANDS` in `app.js`) — the curated "major" brands: **Shell,
  Exxon/Mobil (mobil/exxon/esso), BP/Amoco (bp/amoco/arco), Chevron/Texaco
  (chevron/texaco/caltex), Phillips 66**. Each has a label, accent color, aliases
  (matched on word boundaries so "bp" can't match mid-word), and a logo (Shell from
  the Simple Icons CDN with a pump-icon fallback; the rest are inline SVGs).
  Everything else (Sunoco, Citgo, Gulf, independents…) is `other`. Edit `BRANDS` to
  change the set — filter options, counts and colors all derive from it.
- **Brand filter:** checkbox chips — an **All** master toggle, then every registry
  brand, then **Other**, always shown in every location (a brand with nothing nearby
  shows `(0)`). Defaults after each new result set:
  - majors **with stations here** are checked; majors with 0 are unchecked;
  - **Other is unchecked** (hides independents) — unless the area has *only*
    independents, then Other is checked so the map isn't blank;
  - All shows checked / indeterminate / unchecked to match.
  Hovering the Other chip shows a tooltip listing the independent station names.
- **Home is per-device.** Saved in `localStorage` key `fuelHome` =
  `{lat, lng, label, full}`. No accounts, no backend, not synced across devices,
  lost if site data is cleared — deliberate for a personal app.
- **Startup location:** saved home if one exists → otherwise ask for device location
  (opens to "stations near you") → if denied/unavailable, the Waltham seed
  (60 Hope Ave, shown with the house pin and the label "Hope Ave").
- **Fonts: Poppins. Light mode only** (dark mode was built, then replaced).
- **No bottom sheet** — all station detail lives in the pin card.
- **Hover to open on desktop, tap to open on touch**, detected with
  `matchMedia('(hover: none), (pointer: coarse)')` or `navigator.maxTouchPoints`.
- **No zoom (+/−) buttons.** Leaflet's default zoom control sat behind the toolbar and
  poked out as a stray "beak". Zoom is by scroll / pinch / double-click.
- **Filter chips use colored dots, not logos.** Logos appear only in the pin card.

## How the UI behaves

### Toolbar (top-left on desktop, full-width on mobile)
- **Search bar** (above the card): type a place, press Enter → geocode → stations
  around it at the current radius. Fires on submit only, never per keystroke. On
  success the text box is emptied. The **✕ only clears the text** — it does not
  move the map or return home.
- **Location name** (the current origin's short label; full address on hover) and a
  **freshness stamp**: "Updated Xh ago" for the newest price among visible stations,
  with a colored live dot; "no price data" (grey) if none.
- **Grade** (Reg/Mid/Prem), **brand filter**, **radius slider**.
- On mobile the card becomes a single column; the brand chips become one
  horizontally swipeable row.

### Home group (beside the toolbar on desktop, below it on mobile)
- **Home chip** — disabled and reads "No home set" until a home is saved; then reads
  "Home" (full address as tooltip) and flies to home on click.
- **Gear button** — opens the **Set home address** modal: text field with ✕, Cancel /
  Save; Esc or a backdrop click closes it. Save geocodes the text, stores it, and
  goes to the new home.

### "Stations near me" (bottom-right round button)
Device geolocation → reverse-geocoded label → stations around you. Needs HTTPS
(Vercel provides it) and a one-time permission. Denied → explanatory toast; the
current view stays.

### Map pins
- Each pin is a price tag: brand label (uppercase) + price for the selected grade,
  or a dashed **N/A** tag when that station has no price for it. Tag border, stem and
  dot use the brand color; Other is neutral grey.
- The cheapest visible station gets a green tag and a **◆ CHEAPEST** crown.
- The origin is shown as a **house pin ("HOME")** when it's home or the Waltham
  seed, or a **blue teardrop** for a searched place / your location.
- Changing grade or brands crossfades pins (~65 ms out, then a staggered fade-in).
  `renderMarkers()` is the crossfade wrapper; `drawMarkers()` does the drawing.

### Pin card
Brand logo, station name, distance from the current origin, Open/Closed (omitted
when Google doesn't say), a freshness badge for the selected grade, all three grade
prices (selected one highlighted, N/A where missing), and **NAVIGATE →** (opens
Google Maps for that Place ID).

**Freshness colors** (from each price's Google `updateTime`): under 12 h green,
12–48 h amber, over 48 h red, missing grey. Ages are measured from page-load time
(`NOW`), so they don't tick forward while the page stays open.

### Off-screen / hidden station chips
Any visible station whose pin is off-screen — **or covered by the toolbar or home
group** — gets an arrow chip with its price at the nearest screen edge (or just
outside the covering card). While a chip stands in for a covered pin, that pin is
hidden. Overlapping chips are pushed apart. Clicking a chip flies to the station
(zoom ≥ 14) and opens its card. Recomputed at most once per animation frame during
pan/zoom, and on every filter change.

## Non-obvious implementation details (read before touching)

- **Hover card timing:** open after **40 ms** dwell (`HOVER_OPEN_MS`), close after
  **80 ms** grace (`HOVER_CLOSE_MS`). Entering the card cancels the close, so the
  cursor can travel from pin to card and click NAVIGATE. Hover is bound to the
  visible `.ptag` chip with `mouseenter`/`mouseleave`, not Leaflet's bubbling
  `mouseover`/`mouseout`. (Earlier versions used 130/260 ms; the anti-flicker now
  comes from the pointer-events structure below, not long timers.)
- **Pointer-events are load-bearing.** The popup card
  (`.leaflet-popup-content-wrapper`) is `pointer-events:auto`; the popup tip and
  outer box are forced `none !important` (the tip overlaps the chip and would steal
  hover → flicker). The marker icon box is `none` too — only the price tag (and
  crown) take the mouse, so neighbouring pins' invisible boxes don't overlap.
  `autoPan:false` so opening a card never moves the map. Hover must not change the
  hit target's size or position.
- **Popup motion:** entrance fade is longer and eases out; exits are faster
  (`pop-closing` class added on `popupclose`, removed on `popupopen`).
- **Mobile tap → re-center:** at ≤640 px on touch, opening a card moves the map so
  the card sits centered in the space below the toolbar. Same zoom and pin on
  screen → `panTo` (a flat pan; `flyTo`'s zoom arc caused visible shake). Otherwise
  → `flyTo`. Edge-chip taps on mobile do this in **one** flight (open the card first,
  then fly) to avoid a second "forced scroll".
- **Edge chips are positioned with CSS transforms**, created once per station and
  reused, and only write to the DOM when something changed. Writing `left/top` every
  frame caused layout thrash and pan/zoom lag.
- **Arrow direction:** the arrow is rotated by `atan2(dy, dx) + 90°` from the chip's
  final position toward the station.
- **Framing:** after each result swap the map fits the origin + all stations,
  padded for the toolbar (`PAD`; on mobile the top padding is measured live from
  the toolbar), max zoom 16.
- **Type scale:** `--fs-lg/base/sm/xs` = 18/16/14/12 px in `:root`, named after
  Tailwind sizes. The search input is 14 px on desktop and 16 px on mobile (under
  16 px, iOS Safari zooms on focus). Map pins stay compact on purpose (map-label
  convention: bold price, small uppercase brand name). Change a token in the mobile
  `@media` block rather than per element.

## Running it

- **The real app:** the Vercel deployment. Pushing changes = redeploying the folder
  to that Vercel project with `GOOGLE_SERVER_KEY` set.
- **Locally, UI only:** `Start Hope Ave Fuel.bat` (Python static server on port
  8753) or the `gas-static` entry in `.claude/launch.json` (port 8765). Neither serves
  `/api`, so the map loads but shows "Couldn't load live prices", and search shows
  "Search failed: geocode http 404". Opening `index.html` directly (`file://`) behaves
  the same way.
- **Locally with live data:** `vercel dev` with `GOOGLE_SERVER_KEY` set. Needs Node
  and the Vercel CLI, which are **not installed** on this machine as of 2026-11-24.

### Dev self-check
`_selfcheck.js` runs 13 measurable UI checks (overflow, contrast, tap targets, popup
in safe area, stray map controls, 16 px mobile inputs, …). Each check is scoped to
all / mobile / desktop widths; run it once at a desktop width and once at ≤640 px,
each on a fresh page load:

```js
new Promise(r=>{const s=document.createElement('script');
  s.src='/_selfcheck.js?'+Date.now(); s.onload=()=>r(window.__selfCheck());
  document.head.appendChild(s);})
```

Add a check for each new layout bug so it can't come back.

## Known limitations / open issues

1. **Results capped at 20, ranked by Google's popularity, not distance.** At a large
   radius in a busy area, closer stations can be left out without any warning.
   Adding `rankPreference: 'DISTANCE'` to the `searchNearby` request would fix it.
2. **Edge cache rarely hits for "near me".** The cache key is the exact lat/lng, and
   GPS readings almost never repeat, so most "near me" lookups are paid calls.
   Rounding coordinates (≈3 decimals) in `services.js` would fix it.
3. **Brand is classified from the Google display name only.** A station whose
   display name doesn't contain its brand lands in Other.
4. **Leftovers:** `FuelServices.getHomeStations()` and `FuelData.getStationData()`
   are unused. `--mobil` in `styles.css` is blue (used for the searched-place
   teardrop pin), while the registry's Exxon/Mobil accent is red.
5. **The search error hint** about `file://` only appears for network failures
   (`TypeError`); a static server's 404 shows "Search failed: geocode http 404".
6. **No version control** — the folder isn't a git repository.

## Not done yet (optional next steps)

1. **Autocomplete in the search and set-home fields** — planned and deferred; uses
   Google Place Autocomplete via a new `api/autocomplete.js`, ZIP codes skip it.
2. **Google basemap (optional).** Would need the Maps JavaScript API with a
   *browser* key restricted to the site's domain, plus porting pins/cards/edge
   chips to Advanced Markers and re-solving hover. A fresh build from the current
   `index.html`, not a resurrection of the deleted early Google build.
3. **Cost guardrails** — keep a budget alert set in Google Cloud Console.

## How to check you haven't broken anything

On the deployed site (or `vercel dev`): pins appear with prices; hover (desktop) /
tap (touch) opens a card with a working NAVIGATE link; switching grade or brands
crossfades pins; the cheapest pin has the crown; dragging the radius slider and
releasing re-fetches; search moves the map and updates the location name; "near
me" works after allowing location; setting a home enables the home chip; stations
off-screen or under the toolbar show edge chips. Then run `_selfcheck.js` at both
widths.
