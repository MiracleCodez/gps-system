# GPS System Deployment Units

The deployment is divided into these units so work can resume cleanly:

## Unit 1 — Synchronize the working application

- Copy the working Node.js server, package files, public dashboard, phone tracker, route manifest, and styles into the managed web project.
- Preserve the existing REST API, SQLite schema, demo tracker, dashboard, and smartphone geolocation workflow.

## Unit 2 — Prepare production hosting

- Add a production Dockerfile.
- Ensure the server listens on `0.0.0.0` and honors the hosting `PORT` value.
- Use `/api/health` as the unauthenticated health endpoint.

## Unit 3 — Verify the managed preview

- Install dependencies through the production container build.
- Start the application on the configured runtime port.
- Verify the dashboard, phone tracker, route manifest, health endpoint, device API, and location API.

## Unit 4 — Save and publish

- Commit the intended application files to the managed project's canonical Git remote.
- Configure container deployment with the Dockerfile and health endpoint.
- Publish the saved version to the permanent managed website.

## Unit 5 — Verify the public website

- Confirm the public dashboard returns successfully.
- Confirm `/tracker.html`, `/login`, and `/api/health` are publicly reachable.
- Use the resulting URL for the thesis demonstration.
