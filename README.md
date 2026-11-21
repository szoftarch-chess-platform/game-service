# ♟️ Game Service (NestJS Skeleton)

Game service of the online chess platform. Its responsibilities are decided in ADR-1.

---

## 📁 Architecture & File Structure

```
game-service/
├── src/
│   ├── main.ts                   # Entry point
│   ├── app.module.ts             # Root module (imports GameModule)
│   ├── health.controller.ts      # Health check endpoint
│   ├── health.controller.spec.ts # Unit test suite using Vitest
│   └── game/
│       ├── game.module.ts        # Game module
│       ├── game.service.ts       # Game service stub with TODO comments
│       ├── game.gateway.ts       # WebSocket (Socket.IO) gateway stub with TODO comments
│       └── spectate.gateway.ts   # WebSocket (Socket.IO) gateway stub of the spectators
├── docs/                         # Decisions, open questions and next steps
├── .env.example                  # Environment variables template
├── .npmrc                        # npm settings
├── Dockerfile                    # Container image
├── .dockerignore                 # Files left out of the image build
├── package.json                  # Dependencies and scripts
└── tsconfig.json
```

---

## ⚙️ Environment Configuration

Define the required variables in `.env` or in the container environment:

```ini
# .env
PORT=3001
HOST=127.0.0.1
```

| Variable | Description |
|---|---|
| `PORT` | port that the service listens on |
| `HOST` | address that the service listens on, `127.0.0.1` on the host and `0.0.0.0` in a container |

A template file [`.env.example`](.env.example) is provided in the repository with empty values for all required keys.

---

## 🌐 Endpoints

- `GET /health` - Health check status (`{ "status": "ok", "service": "game-service" }`)

The service has no REST API. ADR-3 decides that every operation of a live game is a Socket.IO event.

### WebSocket Events (Socket.IO):
The service has two Socket.IO paths, and both accept only the WebSocket transport.

`/ws/game` for the players:
- `join_queue` -> Join matchmaking queue (stub)
- `make_move` -> Send chess move (stub)

`/ws/spectate` for the spectators has no events yet.

---

## 🚀 Running Locally

### Prerequisites
- **Node.js**: v26+ (Active LTS)

### 1. Install Dependencies
```bash
cd game-service
npm install
```

### 2. Configure Environment
Create `.env` from the template and fill it in as described under Environment Configuration:
```bash
cp .env.example .env
```

### 3. Run Tests (Vitest)
```bash
npm test
```

### 4. Start Development Server (with hot-reload)
```bash
npm run start:dev
```
The application will listen on the address and the port specified in `.env`.

### 5. Run Behind the Gateway
Keep `PORT=3001`, the port of the container, and add `compose.game-on-host.yaml` to the compose files as the README of the infra repo describes for a service on the host. The gateway at https://localhost:8443 then sends `/ws/game` and `/ws/spectate` to this process. On Linux set `HOST` to the address of the Docker bridge that the README of the infra repo describes.

---

## 🐳 Docker

```bash
docker build -t game-service .
docker run --rm --init -e PORT=3001 -e HOST=0.0.0.0 -p 127.0.0.1:3001:3001 game-service
```

[GS-ADR-1](docs/adr/container-image.md) describes the image.

---

## 📚 Documentation

The decisions, open questions and next steps of the game-service are in [`docs/`](docs/README.md).
