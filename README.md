# ♟️ Game Service

Game service of the online chess platform. Its responsibilities are decided in ADR-1.

---

## 📁 Architecture & File Structure

```
game-service/
├── .github/workflows/        # CI workflow
├── src/                          # Every test file is next to the file that it tests and ends in .spec.ts
│   ├── main.ts                   # Entry point
│   ├── app.module.ts             # Root module
│   ├── health.controller.ts      # Health check endpoint
│   ├── clock/                    # The check of the clocks that have run out
│   ├── config/                   # The settings and their checks
│   ├── domain/                   # The rules of chess and the types of the contracts
│   ├── engine/                   # The client of the engine-service
│   ├── game/                     # The Socket.IO gateways and the operations of a live game
│   ├── outbox/                   # The publisher of the outbox to RabbitMQ
│   └── redis/                    # The state of the live games in Redis
├── docs/                         # Decisions, open questions and next steps
├── .env.example                  # Template of the settings on the host, which the infra setup script fills
├── .npmrc                        # npm settings
├── Dockerfile                    # Container image
├── .dockerignore                 # Files left out of the image build
├── package.json                  # Dependencies and scripts
└── tsconfig.json
```

---

## ⚙️ Environment Configuration

The service reads the variables with `@nestjs/config`, as [GS-ADR-2](docs/adr/configuration.md) decides. A variable of the environment wins over `.env.local`, which wins over `.env`, and both files are optional. In a container compose sets every variable. Every variable is required, and the service stops at startup with an error that names a missing or invalid one.

| Variable | Description |
|---|---|
| `PORT` | port that the service listens on |
| `HOST` | address that the service listens on, `127.0.0.1` on the host and `0.0.0.0` in a container |
| `REDIS_URL` | URL of Redis with the user `game-service`, starting with `redis://` or `rediss://` |
| `RABBITMQ_URL` | URI of RabbitMQ with the user `game-service`, starting with `amqp://` or `amqps://` and ending in `/%2f` for the default virtual host |
| `ENGINE_URL` | address of the engine-service, starting with `http://` or `https://` |

On the host `scripts/dev-setup.mjs` of the infra repo writes `.env` from the template [`.env.example`](.env.example) with the passwords of the `.env` of the infra repo. It writes the file again at every run, so values of your own go into `.env.local`.

---

## 🌐 Endpoints

- `GET /health` - Health check status (`{ "status": "ok", "service": "game-service" }`)

The service has no REST API. ADR-3 decides that every operation of a live game is a Socket.IO event.

### WebSocket Events (Socket.IO):
The service has two Socket.IO paths, and both accept only the WebSocket transport.

`/ws/game` for the players has the events of the contract `game-service.asyncapi.yaml` of the infra repo.

`/ws/spectate` for the spectators has no contract yet.

---

## 🚀 Running Locally

### Prerequisites
- **Node.js**: v26.1+ (Active LTS)
- **Docker** for the tests of the Redis scripts

### 1. Install Dependencies
```bash
cd game-service
npm install
```

### 2. Configure Environment
Run the setup script of the infra repo, which writes `.env` as described under Environment Configuration. Run it again after a pull that changes `.env.example`.
```bash
node ../infra/scripts/dev-setup.mjs
```

### 3. Run Tests (Vitest)
The tests of `RedisService` start Redis in a container with Testcontainers, so Docker has to run. The other tests need nothing else.
```bash
npm test
```

### 4. Start Development Server (with hot-reload)
```bash
npm run start:dev
```
The application will listen on the address and the port of the settings.

### 5. Run Behind the Gateway
Keep `PORT=3001`, the port of the container, and add `compose.game-on-host.yaml` to the compose files as the README of the infra repo describes for a service on the host. The gateway at https://localhost:8443 then sends `/ws/game` and `/ws/spectate` to this process. On Linux set `HOST` in `.env.local` to the address of the Docker bridge that the README of the infra repo describes.

---

## 🐳 Docker

```bash
docker build -t game-service .
docker run --rm --init -e PORT=3001 -e HOST=0.0.0.0 -e REDIS_URL=<REDIS_URL> -e RABBITMQ_URL=<RABBITMQ_URL> -e ENGINE_URL=<ENGINE_URL> -p 127.0.0.1:3001:3001 game-service
```

[GS-ADR-1](docs/adr/container-image.md) describes the image.

---

## 🔄 CI

The workflow in `.github/workflows/game-service.yml` runs the format check, the tests and the build on every pull request and every push to `dev` and `main`, and it builds the image. A tag such as `v1.0.0` also publishes the image for amd64 and arm64 as `ghcr.io/szoftarch-chess-platform/game-service:1.0.0`, as ADR-2 decides.

```bash
git tag v1.0.0
git push origin v1.0.0
```

After its first publication the package can be private. Make it public once in the package settings on GitHub.

---

## 📚 Documentation

The decisions, open questions and next steps of the game-service are in [`docs/`](docs/README.md).
