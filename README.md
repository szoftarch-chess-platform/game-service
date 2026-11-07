# ♟️ Game Service (NestJS Skeleton)

This microservice handles active chess game sessions and real-time WebSocket communication in the online chess platform.
It runs behind a centralized **API Gateway** which routes traffic between the frontend SPA and the backend microservices.

---

## 📁 Architecture & File Structure

```
game-service/
├── src/
│   ├── main.ts               # Entry point (CORS, app.setGlobalPrefix('api'), strict env validation)
│   ├── app.module.ts         # Root module (imports GameModule)
│   ├── app.controller.ts     # Base greeting endpoint (GET /api)
│   ├── app.controller.spec.ts# Unit test suite using Vitest
│   ├── app.service.ts        # Base service
│   └── game/
│       ├── game.module.ts    # Game module
│       ├── game.controller.ts# REST endpoints (health check and NotImplemented stubs)
│       ├── game.service.ts   # Game service stub with TODO comments
│       └── game.gateway.ts   # WebSocket (Socket.IO) gateway stub with TODO comments
├── .env.example              # Environment variables template (no defaults)
├── .npmrc                    # Strict engine enforcement (Node >= 26)
├── Dockerfile                # Multi-platform container configuration (Node 26 Alpine - Active LTS)
├── package.json              # NestJS v12, Socket.IO 4.8, Vitest testing stack
└── tsconfig.json
```

---

## ⚙️ Environment Configuration

There are **no hardcoded default values**. Required variables must be explicitly defined in `.env` (or via container environment):

```ini
# .env
PORT=3001
```

A template file [`.env.example`](.env.example) is provided in the repository with empty values for all required keys.

---

## 🚪 API Gateway Integration

The global **`/api`** prefix is configured in `main.ts`:
- All REST requests must be routed under `/api/...`.
- The API Gateway routes `/api/games/*` requests directly to this service (`http://game-service:PORT/api/games/*`).

### WebSocket Proxying through the API Gateway
Socket.IO requires the API Gateway to support and forward HTTP Upgrade headers:
- `Upgrade: websocket`
- `Connection: Upgrade`
- Default Socket.IO handshake endpoint: `/socket.io/`

---

## 🌐 Endpoints

- `GET /api` - Basic service check (`Chess Game Service is running!`)
- `GET /api/games/health` - Health check status (`{ "status": "ok", "service": "game-service" }`)
- `GET /api/games` - **501 Not Implemented** (`Getting games is not yet implemented`)
- `POST /api/games` - **501 Not Implemented** (`Creating a game is not yet implemented`)
- `GET /api/games/:id` - **501 Not Implemented** (`Getting game :id is not yet implemented`)

### WebSocket Events (Socket.IO):
- `join_queue` -> Join matchmaking queue (stub)
- `make_move` -> Send chess move (stub)

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
Ensure `.env` exists with the required variables:
```bash
cp .env.example .env
# Edit .env and set PORT=3001
```

### 3. Run Tests (Vitest)
```bash
npm test
```

### 4. Start Development Server (with hot-reload)
```bash
npm run start:dev
```
The application will listen on the port specified in `.env`.
