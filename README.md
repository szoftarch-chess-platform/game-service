# ♟️ Game Service (NestJS Skeleton)

Game service of the online chess platform. Its responsibilities are decided in ADR-1.

---

## 📁 Architecture & File Structure

```
game-service/
├── src/
│   ├── main.ts               # Entry point
│   ├── app.module.ts         # Root module (imports GameModule)
│   ├── app.controller.ts     # Base greeting endpoint
│   ├── app.controller.spec.ts# Unit test suite using Vitest
│   ├── app.service.ts        # Base service
│   └── game/
│       ├── game.module.ts    # Game module
│       ├── game.controller.ts# REST endpoints
│       ├── game.service.ts   # Game service stub with TODO comments
│       └── game.gateway.ts   # WebSocket (Socket.IO) gateway stub with TODO comments
├── docs/                     # Decisions and open questions
├── .env.example              # Environment variables template
├── .npmrc                    # npm settings
├── Dockerfile                # Container image
├── package.json              # Dependencies and scripts
└── tsconfig.json
```

---

## ⚙️ Environment Configuration

Define the required variables in `.env` or in the container environment:

```ini
# .env
PORT=3001
```

A template file [`.env.example`](.env.example) is provided in the repository with empty values for all required keys.

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
The application will listen on the port specified in `.env`.

---

## 📚 Documentation

The decisions and open questions of the game-service are in [`docs/`](docs/README.md).
