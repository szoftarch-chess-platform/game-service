# GS-ADR-1: Multi-stage container image

**Related:** NF-9, ADR-2

## Context

The service runs as a container image, which the CI and the compose of the infra repo build.

## Decision

- The multi-stage `Dockerfile` builds the service with `node:26-alpine`. The final stage starts from the same image and installs only the runtime dependencies with `npm ci --omit=dev`.
- The service runs as the non-root user `node`, and `node` starts it directly, not through npm.
- On a stop signal such as SIGTERM the service runs the shutdown hooks of Nest, which close its server and its connections to Redis and RabbitMQ before the process ends.
- The image sets no port or address. The service listens on the port of the required `PORT` environment variable and on the address of the required `HOST` environment variable, which compose sets to `0.0.0.0`.
- The image has no `HEALTHCHECK`. The compose of the infra repo checks `GET /health`, which is the only HTTP endpoint of the service.

## Rationale

- The final image carries no compiler, no test tools and no sources, so it is smaller and has fewer packages that need security fixes.
- `npm ci` installs exactly the versions of `package-lock.json`, so the image does not depend on when it is built.
- A service that does not run as root can do less harm if it is compromised. The `node` user is part of the official image.
- The image uses the Node.js version that the developers use, and the tag follows its releases, so fixes arrive without a change.
- Without the shutdown hooks the process ends at once on SIGTERM, so Redis and RabbitMQ see a lost connection instead of a closed one.

## Rejected alternatives

- **Single stage with `npm install`:** simpler, but the image carries the development dependencies, it runs as root, and the installed versions can differ from the lock file.
- **Start through `npm run start:prod`:** npm stays in memory as an extra process between Docker and the service.

## Consequences

- Node.js does not stop on SIGTERM when it runs as process 1 and has no handler for the signal. The shutdown hooks are such a handler, and the compose of the infra repo still sets `init: true` and `docker run` uses `--init`, as the Docker and Node.js best practices recommend for Node.js in a container.

## Sources

- Official node image: https://hub.docker.com/_/node
- Docker and Node.js best practices: https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
- `npm ci`: https://docs.npmjs.com/cli/commands/npm-ci
- NestJS lifecycle events, application shutdown: https://docs.nestjs.com/fundamentals/lifecycle-events#application-shutdown
