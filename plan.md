# GPS System — Implementation Plan

## Product goal

A smartphone-powered GPS location tracking and management website for a small fleet prototype. A phone browser acts as the tracking device; an administrator dashboard displays the latest location, history, trips, and device status.

## MVP behavior

- A tracker can be registered with a name and type.
- A phone tracking page requests geolocation permission and sends coordinates to the API while tracking is active.
- An administrator dashboard shows registered trackers on a Leaflet/OpenStreetMap map.
- The dashboard refreshes latest locations, status, speed, accuracy, and last-seen time.
- Location history can be viewed for a selected tracker.
- A trip can be started and ended from the phone tracker page.
- The API persists devices, locations, and trips in SQLite.
- A simulated/demo tracker is seeded so the dashboard is useful before a phone connects.

## Architecture

- `server.js`: Express HTTP server, API routes, static file serving, and SQLite initialization.
- `public/index.html`: dashboard shell.
- `public/app.js`: dashboard state, API calls, map markers, and history chart.
- `public/tracker.html`: phone tracking interface.
- `public/tracker.js`: browser geolocation watcher and coordinate submission.
- `public/styles.css`: responsive visual system.
- `gps.db`: local runtime database created automatically and ignored by Git.

## Design direction

- **Movement:** calm operations-console design with a dark navy canvas and luminous mint status accents.
- **Core principles:** glanceable status, clear hierarchy, mobile-first controls, and map-led context.
- **Color philosophy:** navy provides focus for map and telemetry; mint indicates healthy live flow; amber and coral reserve urgency for stale data and alerts.
- **Layout paradigm:** a map-first workspace with a compact telemetry rail rather than a generic centered dashboard grid.
- **Signature elements:** live pulse markers, uppercase telemetry labels, and a route-history ribbon.
- **Interaction:** actions should be explicit and reversible; the tracking page exposes a single prominent start/stop control.
- **Animation:** subtle marker pulse and status transitions only; no distracting motion.
- **Typography:** system sans stack for reliable rendering, with tabular numerals for telemetry.
- **Brand essence:** a practical field-operations command center for teams that need location visibility without dedicated hardware. Personality: clear, dependable, grounded.

## Delivery phases

1. Scaffold API, database schema, and seeded demo tracker.
2. Build responsive dashboard and map view.
3. Build phone tracker page with permission and trip controls.
4. Add history, status, and operational feedback.
5. Run API smoke tests and commit/push the working MVP.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000/` for the dashboard and `http://localhost:3000/tracker.html` on a phone connected to the same network for tracking. Browser geolocation generally requires HTTPS or localhost; use a secure tunnel/hosted deployment for a physical phone outside localhost.
