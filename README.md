# Hope Ave Fuel

Personal gas-price tracker for Shell/Mobil stations near 60 Hope Ave,
Waltham, MA. Built interactively in Claude.ai; this folder is a handoff to
continue the work in Claude Code.

## Start here

1. **Read `DECISIONS.md` first.** It captures every explicit decision made
   so far (scope, radius, brands, UI choices) and several non-obvious
   implementation details that are easy to accidentally break. Skipping
   this will cost you more time than reading it.
2. **Read `DATA-SHAPE.md` second**, especially before touching anything
   related to live data — it's the exact contract the frontend expects.
3. **Run it over `http://`, not `file://`** — double-click
   **`Start Hope Ave Fuel.bat`** (Windows; needs Python, which is already
   installed here). It serves the folder at `http://localhost:8753` and opens
   your browser. Keep that window open while using the app.
   - You *can* still open `index.html` directly (`file://`) — the map and the 7
     sample stations work fine — but **location search will not**: browsers block
     `file://` pages from calling outside services (Nominatim/Overpass), so the
     search returns "Can't reach the search service." Running over `http://`
     fixes it. No build step either way.

## Files

The app was split out of a single `index.html` into a few plain files for
modularity. There's still **no build step and no server** — `index.html`
loads `styles.css`, `data.js`, `services.js`, and `app.js` via relative paths
and plain `<script>`/`<link>` tags (intentionally not ES modules, so `file://`
still works). Just open `index.html`.

| File | What it is |
|---|---|
| `index.html` | Markup + asset links. Loads Leaflet (CDN), then `data.js`, `services.js`, `app.js` (in that order). **Open this.** |
| `styles.css` | All UI styling (was the inline `<style>` block). |
| `data.js` | The sample-data **fixture** — `HOME` + `getStationData()`, exposed on `window.FuelData`. The current hand-written prices live here. |
| `services.js` | **The single external-data boundary** (`window.FuelServices`): `getHomeStations()`, `geocode()`, `findStationsNear()`. Calls the Google proxy under `api/` (same-origin `fetch('/api/...')`). Domain helpers (brand classifier, distance) are injected by `app.js` so this layer stays UI-agnostic. |
| `app.js` | All app logic — map, tiles+fallback, markers/popups, edge indicators, controls, search UI. Reads external data **only** through `window.FuelServices`. Wrapped in an IIFE, organized into labeled sections; boots asynchronously. |
| `api/geocode.js`, `api/stations.js` | Vercel serverless functions — the proxy to Google (Geocoding + Places `fuelOptions`). Keep the API key server-side; read it from the `GOOGLE_SERVER_KEY` env var. |
| `DECISIONS.md` | Project decisions, scope, and gotchas. Read first. |
| `DATA-SHAPE.md` | The exact JS object shape the frontend expects from `getStationData()` / a future `fetch('/api/prices')`. |

## Location search

The toolbar card has a search bar: type any place ("Cambridge, MA", a street,
a ZIP) and the map swaps to gas stations near there. The card's location name
updates, and the locate button (or the ✕ in the search box) returns to the
original 7 Hope Ave stations.

It's **keyless** — geocoding via OpenStreetMap Nominatim, nearby stations via
Overpass — so it works from `file://` with no API key or proxy. Both calls live
in `services.js` (`geocode()` / `findStationsNear()`), not `app.js`. The tradeoff:
OSM has station *locations* but not *prices*, so searched stations render in the
honest "no data" (`N/A`) state. The results are shaped exactly like
`getStationData()`, so swapping in the planned Google `fuelOptions` proxy — by
editing `services.js` only — fills in prices with no UI changes. See
`DECISIONS.md` for the full rationale.

### Brands & filtering

Raw map data lists *every* fuel station, including unbranded/independent pumps —
too noisy. So `app.js` holds a curated **brand registry** (`BRANDS`): the set of
"major" brands we care about. Each entry has a display label, an accent color
(used for the pin/chip/dot theming via an inline `--brand` CSS variable), the
messy real-world name aliases that map to it, and optionally a real logo.

- **Current majors:** Shell · Exxon/Mobil · BP/Amoco · Chevron/Texaco · Phillips 66.
  (Aliases fold variants together, e.g. Exxon + Mobil + Esso → one entry; matched
  on word boundaries so short tags like `bp` don't match inside other words.)
- **Why a registry:** one edit-in-one-place source of truth. Add or remove a brand
  by editing `BRANDS` — the filter checkboxes, counts, and colors are all derived
  from it. `classifyBrand()` maps each search result to a registry brand or `other`.
- **The filter** is a multi-select checkbox group with an **All** master toggle,
  every registry brand, and an **Other** bucket. The registry groups are **always
  shown in every location** (a brand with nothing in radius just shows count `0`),
  so the options stay consistent rather than appearing/disappearing per search.
  Majors are checked by default; **Other (independents) is unchecked by default**,
  which is what keeps searches from showing junk — tick it to reveal them.

Full reasoning and the non-obvious bits live in `DECISIONS.md`; the `brand` field
contract is in `DATA-SHAPE.md`.

## Live data (Google)

Live prices + search now come from **Google** through the serverless proxy in
`api/` (Geocoding + Places `fuelOptions`), called via the `services.js` boundary.
Deploy to a host with serverless functions (e.g. Vercel), set the
`GOOGLE_SERVER_KEY` env var, and the home map + search show real prices. Run
locally without the proxy (`file://` or a plain static server) and the app shows
an explicit "couldn't load live prices" state — it never falls back to fake
sample numbers. (The sample data in `data.js` remains only as a fixture/reference.)

The one piece still **not** from Google is the *basemap*: it's Leaflet with light
CARTO tiles (reads close to Google), which is intentional and sufficient for
current needs. A pixel-true Google basemap is optional and not required — see
`DECISIONS.md` ("What's NOT done yet") if you ever want it; it would be a fresh
build from the current `index.html`, not a resurrection of any old file.
