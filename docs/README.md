# game-service documentation

- System documentation: the `docs/` folder of the infra repo

## ADRs

| ID | Title |
|---|---|
| [GS-ADR-1](adr/container-image.md) | Multi-stage container image |

## Open questions

- The Redis client, and the data model of the queue, the games and the outbox with the atomic updates that ADR-3 requires.
- How a clock that runs out ends its game on any instance without an incoming event (ADR-10), for example with the deadlines in a sorted set of Redis.
- How the payloads of the events are validated against the contract.
- Where the UUID v7 of a game comes from, for example the `uuid` package or a function of Node.js.

## Implementation status

- ✅ Read user identity from `x-user-id` and `x-user-name` headers during WebSocket handshake (ADR-4).
- ✅ Contract events on `/ws/game` implemented (`joinQueue`, `leaveQueue`, `startBotGame`, `makeMove`, `resign`, `getState`) with acknowledgments and error codes (`game-service.asyncapi.yaml`).
- ✅ Matchmaking queue (FIFO) and games in Redis, atomic Lua scripts for queue and updates (ADR-3, ADR-10).
- ✅ Sakk játékszabályok chess.js alapokon: lépésvalidáció, matt, patt, hármas ismétlés, 50-lépéses szabály, elégtelen anyag (ADR-9, ADR-10).
- ✅ Sakkóra (10 perc kezdő, nincs inkrementum, bot óra kezelés, FIDE 6.9 döntetlen timeout esetén elégtelen anyaggal) és Redis Sorted Set alapú háttérfigyelő (ADR-10).
- ✅ Engine-service integráció `POST /moves` hívással, 15s timeouttal és 1 retry-val 500-as hiba esetén, motorkudarc esetén `aborted` / `engineFailure` lezárással (ADR-6, ADR-10).
- ✅ Tranzakcionális outbox Redisben és megbízható RabbitMQ közzététel a `game.events` topic exchange-re `game.finished` routing key-jel és publisher confirm-mel (ADR-6).
- ✅ CI workflow in `.github/workflows/game-service.yml` for tests, format checks, builds and GHCR publishing on tags (ADR-2).

## Next steps

- GHCR container image publish on first release tag.
