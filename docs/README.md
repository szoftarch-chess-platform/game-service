# game-service documentation

- System documentation: the `docs/` folder of the infra repo

## ADRs

| ID | Title |
|---|---|
| [GS-ADR-1](adr/container-image.md) | Multi-stage container image |

## Open questions

- The Redis client, and the data model of the queue, the games and the outbox with the atomic updates that ADR-3 requires.
- How a clock that runs out ends its game on any instance without an incoming event (ADR-10), for example with the deadlines in a sorted set of Redis.
- The RabbitMQ client, and how the outbox is sent on with publisher confirms and the mandatory flag (ADR-6).
- How the payloads of the events are validated against the contract.
- Where the UUID v7 of a game comes from, for example the `uuid` package or a function of Node.js.

## Next steps

- Read the user from `x-user-id` and `x-user-name` of the handshake (ADR-4), and read `REDIS_URL`, `RABBITMQ_URL` and `ENGINE_URL` as required settings (ADR-6).
- Describe in the README how the service runs on the host against Redis and RabbitMQ of the infra compose, with `ENGINE_URL` pointing to an engine-service on the host or to a fake of it (ADR-6).
- Replace the stub events with the events of the contract `game-service.asyncapi.yaml` of the infra repo, with their acknowledgements and error codes, and update the README.
- Keep the queue, the games and the outbox in Redis, add the Redis adapter of Socket.IO (ADR-3), and send the events of a game to every connection of its players (ADR-10).
- Check the moves and the end of the game with chess.js (ADR-9), and run the clock of ADR-10.
- Call the engine-service as the contract `engine-service.openapi.yaml` describes, with the timeout and the repeat of ADR-6, and end the game as aborted if both requests fail (ADR-10). Until the engine-service is ready, the tests use a fake engine (ADR-7).
- Publish `game.finished.v1` of the contract `game-events.asyncapi.yaml` from the outbox (ADR-6). To see the messages in the management interface of RabbitMQ, bind a test queue there to `game.finished` on `game.events`, because the broker returns the messages that no queue gets.
- Add the CI workflow of ADR-2.
