# game-service documentation

- System documentation: the `docs/` folder of the infra repo

## ADRs

| ID | Title |
|---|---|
| [GS-ADR-1](adr/container-image.md) | Multi-stage container image |

## Open questions

None yet.

## Next steps

- Agree on the contracts of ADR-2 with the other repos.
- Read the user from the identity headers of the handshake, as ADR-4 decides.
- Build the parts of ADR-3 that belong to this service, which are the Socket.IO events of the live game, the Redis adapter and the check of the spectator link on `/ws/spectate`.
- Build the parts of ADR-6 that belong to this service, which are the engine call, the outbox and the sender of the finished games.
