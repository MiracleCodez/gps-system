# GPS System

A web-based GPS location tracking and management system designed for a BSc project. It uses a smartphone browser as the GPS device, so no car or dedicated tracker is required.

## What is included

The app has two views:

- **Dashboard** (`/`) — register trackers, see live/latest positions, inspect telemetry, and review route history.
- **Phone tracker** (`/tracker.html`) — open this on a smartphone, grant location permission, start tracking, and start/end a trip.

The backend stores devices, GPS points, and trips in SQLite. A demo tracker with sample coordinates is created automatically on first startup so the map is not empty.

## Thesis documentation package

The repository includes a thesis-ready technical handbook with the analysis, methodology, requirements, architecture, database design, data dictionary, API specification, implementation description, testing plan, limitations, user guide, and recommended chapter structure:

- [Download the thesis documentation Markdown](docs/GPS-System-Thesis-Documentation.md)
- [Download the thesis documentation PDF](docs/GPS-System-Thesis-Documentation.pdf)
- [Open the documentation index](docs/README.md)
- [Browse Mermaid diagram sources](docs/diagrams/)
- [Browse rendered PNG diagrams](docs/rendered/)

The diagrams include system context, use case, data-flow, architecture, ERD, sequence, activity, and deployment views.

## Run locally

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000). For a phone on the same Wi-Fi network, use the computer's LAN address, for example `http://192.168.1.10:3000/tracker.html`. Browser geolocation normally requires HTTPS or localhost, so for a physical-phone demo use an HTTPS development tunnel or deploy the app to a secure host.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/devices` | List trackers and latest location |
| POST | `/api/devices` | Register a tracker |
| GET | `/api/devices/:id/locations` | Read location history |
| POST | `/api/locations` | Store a phone GPS update |
| POST | `/api/trips/start` | Start a trip |
| POST | `/api/trips/end` | End the active trip |
| GET | `/api/trips` | List recent trips |

## Thesis extension ideas

The MVP is intentionally hardware-free. A thesis can extend it with role-based authentication, geofences, route-deviation alerts, SMS/email notifications, a PWA install flow, PostgreSQL/PostGIS, and analytics for distance, speed violations, and device uptime.

## Project status

MVP complete: responsive dashboard, smartphone geolocation tracker, SQLite persistence, trip management, map display, demo seed data, API smoke-test coverage, and thesis documentation artifacts.
