# GS-ADR-3: State of the live games in Redis

**Related:** F-2, NF-3, NF-6, X-1, ADR-3, ADR-6, ADR-8, ADR-10

## Context

ADR-3 keeps no state of the games or of the pairing in the memory of the process, so any instance can serve any event, and two events of the same game can arrive at two instances at the same time. ADR-10 lets a user wait or play only one game at a time, and it ends a game whose clock runs out even if no event arrives. ADR-6 writes the event of a finished game into an outbox in Redis together with the end, and ADR-8 gives every game and every event a UUID v7.

## Decision

- Redis holds the state in these keys.

| Key | Type | Content |
|---|---|---|
| `user:status:<userId>` | string | `queue` while the user waits and `game:<gameId>` while the user plays, missing while the user is free |
| `queue:players` | list | the waiting user as the JSON of the player |
| `game:<gameId>` | string | the game as the JSON of `GameState` of `game-service.asyncapi.yaml`, with the time of its last move |
| `game:deadlines` | sorted set | a member such as `<gameId>:white` for every running clock, whose score is the time in milliseconds at which the clock runs out |
| `outbox:events` | list | the events `game.finished.v1` as JSON, with the oldest one at the tail |

- Every change of more than one key is a Lua script, which Redis runs as a whole. The scripts start a game against the bot, join the queue or pair with the waiting user, leave the queue, store a move and end a game.
- A script that starts a game checks that its users are free and writes the game, the statuses of its users and its first deadline together, so two starts at the same time make one game. A user who joins while another user waits is paired with that user at once, so the queue holds at most one user.
- An event stores a move or an end only if the game still has the number of moves that the event read, and it pairs with a waiting user only if that user is still at the head of the queue. Otherwise the script stores nothing of the event, and the event reads again. An event tries at most three times, and after the third conflict it fails with `internalError`.
- The script of the end deletes the game, its deadline and the statuses that still name it, and it pushes the event of the end onto the outbox, which is the transaction of ADR-6. A later event of the game finds no game, and a move of the bot that comes after the end is dropped.
- The script of a move replaces the deadline of the game with the deadline of the clock that runs next. While the bot thinks no clock runs, so the game has no deadline.
- Once a second every instance looks for the deadlines that have passed and ends their games on time. A deadline stays until the end of its game removes it, so an end that fails is tried again at the next check. A move that comes after the time of its user has run out ends the game on time too.
- Every 1.5 seconds every instance sends the events of the outbox to RabbitMQ from the oldest one, and it removes an event by its JSON once the broker has confirmed it.
- The ids of the games and of the events come from `randomUUIDv7` of `node:crypto`.
- The tests of `RedisService` run against Redis in a container that Testcontainers starts from the image of the infra compose, with the users of ADR-6.

## Rationale

- Redis runs a script as a whole and blocks every other command meanwhile, so no event sees half of a change, and the check and the change take one round trip. The documentation of Redis says that a script can do everything that a transaction can, and usually simpler and faster.
- The check of the number of moves is optimistic concurrency. Two events of one game rarely meet, so the event that came second reads again, instead of every event waiting for a lock. The number of moves is part of the game, so it needs no version of its own.
- Every event reads the game as a whole, and the scripts read the number of moves from its JSON with `cjson`, so one string per game is enough.
- A sorted set by the time at which the clocks run out gives the passed deadlines of every game with one range query, which any instance can run, as ADR-10 asks. Since the script of a move writes the next deadline, a game never keeps the deadline of an old clock.
- The script of the end changes nothing in a game that has ended or changed, so an end that is tried again, or by two instances at the same time, ends the game once. No instance has to claim a deadline, and a failure between the check and the end loses no deadline.
- An event leaves the outbox only after the broker has confirmed it, so neither a crash nor a broker that is down loses it. Two instances can send the same event, and the consumer of ADR-6 filters out the second one by its id.
- Node.js creates a UUID v7 of RFC 9562 since version 26.1, so the ids need no dependency.
- Only Redis runs the scripts, so a test with a mock of the client would pass a script with a wrong key. With the users of ADR-6 the tests also find a command that the user of the service may not run.

## Rejected alternatives

- **WATCH with MULTI and EXEC:** WATCH belongs to a connection, so every event that runs at the same time would need a connection of its own, and the check would cost another round trip.
- **Functions of Redis:** Redis keeps and replicates them, but they have to be loaded into Redis before the service uses them, and two versions of the service during an update would share one library. A script is part of the code of its version.
- **SET with IFEQ of Redis 8.4:** it compares the value of one key, while a move also changes the deadlines, and an end also changes the statuses and the outbox.
- **A lock for every game:** an instance that stops while it holds a lock blocks the game until the lock expires, and a lock with an expiry does not protect an instance that pauses for longer than the expiry.
- **A hash for every game:** every event reads the whole game, and the moves would need a list of their own, so a hash would only make the scripts longer.
- **Expiring keys with keyspace notifications:** Redis sends the event of an expired key only when it deletes the key, which can be much later, Pub/Sub loses the events while a subscriber is disconnected, and every instance would get every event.
- **A timer in the instance that stored the last move:** it would be lost with the instance, which ADR-3 does not allow.
- **The instance that removes a passed deadline ends the game:** the instances would not try the same end at the same time, but an instance that fails after the removal would leave the game without a deadline.
- **v7 of the `uuid` package:** it creates the same kind of ids with one more dependency to keep up to date.
- **Tests with a mock of the client:** they need no Docker, but they check only the arguments of the calls and not what the scripts do.

## Consequences

- The scripts use keys of several hash slots, so a Redis Cluster would need hash tags in the names of the keys.
- The times of the clocks and of the deadlines come from the instances, so the hosts of the instances need synchronized clocks, for example with NTP. A difference between two hosts changes the time of a move by the same amount.
- A game in which nobody moves ends up to a second after its time has run out.
- Every instance checks the deadlines and the outbox, so every new instance adds requests to Redis even while nothing happens.
- While the end of a game keeps failing, every check tries it again and logs the error.
- The tests need Docker, locally and in the CI. The image and the users of the tests are a copy of the compose of the infra repo, so a change of them is made in both places.
- The service needs Node.js 26.1 or newer.

## Open questions

- Whether the service moves from ioredis to node-redis. The README of ioredis says that ioredis is maintained on a best-effort basis and recommends node-redis for new projects.
- How a game goes on whose instance stops or cannot store the move while the bot thinks. No clock runs then, so no deadline ends the game, and its user can only resign.

## Sources

- Redis, scripting with Lua: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Redis, functions: https://redis.io/docs/latest/develop/programmability/functions-intro/
- Redis, transactions: https://redis.io/docs/latest/develop/using-commands/transactions/
- Redis, keyspace notifications: https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/
- Redis, sorted sets: https://redis.io/docs/latest/develop/data-types/sorted-sets/
- Redis cluster specification, hash tags: https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags
- Martin Fowler, Optimistic Offline Lock: https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html
- Martin Kleppmann, How to do distributed locking: https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- Node.js, `crypto.randomUUIDv7`: https://nodejs.org/api/crypto.html#cryptorandomuuidv7options
- RFC 9562, UUID v7: https://www.rfc-editor.org/rfc/rfc9562
- ioredis: https://github.com/redis/ioredis
- Testcontainers for Node.js, Redis module: https://node.testcontainers.org/modules/redis/
