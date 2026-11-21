# GS-ADR-1: Multi-stage container image

**Related:** NF-9, ADR-2

## Context

The service runs as a container image, which the CI and the compose of the infra repo build.

## Decision

- The multi-stage `Dockerfile` builds the service with `node:26-alpine`. The final stage starts from the same image and installs only the runtime dependencies with `npm ci --omit=dev`.
- The service runs as the non-root user `node`, and `node` starts it directly, not through npm.
- The image sets no port or address. The service listens on the port of the required `PORT` environment variable and on the address of the required `HOST` environment variable, which compose sets to `0.0.0.0`.
- The image has no `HEALTHCHECK`. The compose of the infra repo checks `GET /health`, which is the only HTTP endpoint of the service.

## Rationale

- The final image carries no compiler, no test tools and no sources, so it is smaller and has fewer packages that need security fixes.
- `npm ci` installs exactly the versions of `package-lock.json`, so the image does not depend on when it is built.
- A service that does not run as root can do less harm if it is compromised. The `node` user is part of the official image.
- The image uses the Node.js version that the developers use, and the tag follows its releases, so fixes arrive without a change.

## Rejected alternatives

- **Single stage with `npm install`:** simpler, but the image carries the development dependencies, it runs as root, and the installed versions can differ from the lock file.
- **Start through `npm run start:prod`:** npm stays in memory as an extra process between Docker and the service.

## Consequences

- Node.js does not stop on SIGTERM when it runs as process 1 and has no handler for the signal, so Docker kills the container only after its stop timeout. The compose of the infra repo sets `init: true`, and `docker run` needs `--init`.

## Sources

- Official node image: https://hub.docker.com/_/node
- Docker and Node.js best practices: https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
- `npm ci`: https://docs.npmjs.com/cli/commands/npm-ci
