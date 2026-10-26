# GPS System
A web-based GPS location tracking and management system designed for a BSc project. It uses smartphone browsers as GPS devices, so no car or dedicated tracker is required.

## User roles and dashboards
The system supports two roles:

- **Administrator** (`/admin`) — sees every tracker, registers devices, assigns each device to a viewer account, and can open each phone's unique tracker link.
- **Viewer/user** (`/dashboard`) — sees only the tracker devices assigned to that account and can view their map, telemetry, route history, and trips.

The first account created during first-time setup is the administrator. After that, people can create viewer accounts from the login page. The administrator should create one tracker record per phone and assign it to the correct viewer account. The response shows a unique tracker link such as `/tracker.html?token=...`; open that link on the assigned phone after signing in as its viewer.

Each phone has its own browser session and tracking token. This allows phones in different locations to send GPS updates at the same time without mixing their data. The backend checks both the logged-in account and the device token before accepting an update.

## What is included
- Responsive administrator and viewer dashboards
- Smartphone geolocation tracker with HTTPS support
- Per-phone tracker tokens and account/device assignment
- Express REST API with role-based access checks
- SQLite persistence for local development
- Devices, GPS points, trips, route history, and Leaflet map display
- First-run administrator setup and viewer self-registration
- Thesis draft, technical documentation, database schema, research notes, diagrams, and PDF exports

## Run locally
```bash
npm install
npm start
```

Then open `http://localhost:3000`. For a phone on the same Wi-Fi network, use the computer's LAN address. Browser geolocation normally requires HTTPS or localhost, so for a physical-phone demo use an HTTPS development tunnel or deploy the app to a secure host.

## Multiple-phone demonstration
1. Create the first account as administrator.
2. Create one viewer account per phone, or use one viewer account if the same person operates more than one assigned tracker.
3. From `/admin`, add one tracker for each phone and assign the correct viewer account.
4. On each phone, sign in with its assigned viewer account and open its unique tracker link.
5. Start tracking on each phone. The administrator dashboard shows the phones as separate devices.

## API overview
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/users` | List viewer accounts for administrators |
| GET | `/api/devices` | List all devices for administrators or assigned devices for viewers |
| POST | `/api/devices` | Create and assign a tracker (administrator only) |
| GET | `/api/tracker/context` | Resolve the signed-in phone's assigned tracker |
| GET | `/api/devices/:id/locations` | Read location history for an accessible tracker |
| POST | `/api/locations` | Store a location update for the assigned tracker |
| POST | `/api/trips/start` | Start a trip for the assigned tracker |
| POST | `/api/trips/end` | End a trip for the assigned tracker |
| GET | `/api/trips` | List trips visible to the signed-in account |

## Netlify note
The frontend can be hosted on Netlify, but this repository's Express server and local SQLite database need conversion before production Netlify deployment. Netlify deployment requires serverless functions and persistent database storage; the Dockerfile is intended for a continuously running Node host.

## Thesis documentation package
The repository also includes:

- [Final-year thesis draft](docs/Final-Year-Thesis-Draft.md) and PDF
- [Technical documentation handbook](docs/GPS-System-Thesis-Documentation.md) and PDF
- [Database schema](docs/database-schema.sql)
- [Research sources and fieldwork notes](docs/research-sources.md)
- [Documentation index](docs/README.md)
- Mermaid diagram sources and rendered PNG diagrams

The documentation covers the analysis, methodology, requirements, architecture, database design, data dictionary, API specification, implementation description, testing plan, limitations, user guide, and recommended chapter structure.

## Project status
The MVP and thesis documentation are complete. The multi-phone update adds separate administrator/viewer dashboards, device ownership, per-phone tracker tokens, scoped location/trip access, and administrator assignment of phones to viewer accounts.
