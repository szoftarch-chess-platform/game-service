# game-service documentation

- System documentation: the `docs/` folder of the infra repo

## ADRs

| ID | Title |
|---|---|
| [GS-ADR-1](adr/container-image.md) | Multi-stage container image |
| [GS-ADR-2](adr/configuration.md) | Settings with @nestjs/config |
| [GS-ADR-3](adr/game-state.md) | State of the live games in Redis |

## Open questions

- How the payloads of the events are validated against the contract.

## Implementation status

- ✅ Read user identity from `x-user-id` and `x-user-name` headers during WebSocket handshake (ADR-4).
- ✅ Contract events on `/ws/game` implemented (`joinQueue`, `leaveQueue`, `startBotGame`, `makeMove`, `resign`, `getState`) with acknowledgments and error codes (`game-service.asyncapi.yaml`).
- ✅ The queue, the games, the deadlines of the clocks and the outbox in Redis, which Lua scripts change, so two starts at the same time make one game, and a user who leaves the queue during a pairing stays out of the game ([GS-ADR-3](adr/game-state.md)).
- ✅ A move or an end that meets another event of the same game reads the game again, and every later event of an ended game gets `gameNotFound`, also a move that comes after the time of its user has run out ([GS-ADR-3](adr/game-state.md), ADR-10).
- ✅ The user leaves the queue when the last connection closes (ADR-10), and an event whose handler fails gets the acknowledgement `internalError` instead of none (`game-service.asyncapi.yaml`).
- ✅ The rules of chess with chess.js, which are the legal moves, checkmate, stalemate, threefold repetition, the fifty-move rule and insufficient material (ADR-9, ADR-10).
- ✅ Clocks of 10 minutes without increment and no clock for the bot, and a game that ends on time is a draw when the opponent has only the king or the king and a single bishop or knight (ADR-10). Every instance ends the games whose clock has run out ([GS-ADR-3](adr/game-state.md)).
- ✅ The moves of the bot from `POST /moves` of the engine-service, with a timeout of 15 seconds and one repeat of a failed request except after 400 and 422, and an end as `aborted` with `engineFailure` when the engine fails (ADR-6, ADR-10). Another instance asks again for a move of the bot that has not been stored in time ([GS-ADR-3](adr/game-state.md)).
- ✅ The outbox in Redis, from which every instance publishes `game.finished.v1` to the topic exchange `game.events` with the routing key `game.finished`, publisher confirms and the mandatory flag (ADR-6, [GS-ADR-3](adr/game-state.md)).
- ✅ CI workflow in `.github/workflows/game-service.yml` for tests, format checks, builds and GHCR publishing on tags (ADR-2).

## Next steps

- GHCR container image publish on first release tag.
