# GS-ADR-3: State of the live games in Redis

**Related:** F-2, NF-3, NF-6, X-1, ADR-3, ADR-6, ADR-8, ADR-10, FE-ADR-5

## Context

ADR-3 keeps no state of the games or of the pairing in the memory of the process, so any instance can serve any event, and two events of the same game can arrive at two instances at the same time. ADR-10 lets a user wait or play only one game at a time, it ends a game whose clock runs out even if no event arrives, and it ends a game as aborted only when the engine does not answer. ADR-6 writes the event of a finished game into an outbox in Redis together with the end, and ADR-8 gives every game and every event a UUID v7.

## Decision

- The client is `@redis/client`, the base package of node-redis, with one connection for each instance. It runs the scripts with EVALSHA, and it sends their source with EVAL only while Redis does not know them yet.
- A command that cannot be sent within 5 seconds, for example while the connection is lost, fails and is never sent. The client connects again by itself after growing delays.
- Redis holds the state in these keys.

| Key | Type | Content |
|---|---|---|
| `user:status:<userId>` | string | `queue` while the user waits and `game:<gameId>` while the user plays, missing while the user is free |
| `queue:players` | list | the waiting user as the JSON of the player |
| `game:<gameId>` | string | the game as the JSON of `GameState` of `game-service.asyncapi.yaml`, with the time of its last move |
| `game:deadlines` | sorted set | a member such as `<gameId>:white` for the color whose turn it is in every game, whose score is the time in milliseconds of its deadline |
| `outbox:events` | list | the events `game.finished.v1` as JSON, with the oldest one at the tail |

- Every change of more than one key is a Lua script, which Redis runs as a whole. The scripts start a game against the bot, join the queue or pair with the waiting user, leave the queue, store a move, end a game and claim a deadline.
- A script that starts a game checks that its users are free and writes the game, the statuses of its users and its first deadline together, so two starts at the same time make one game. A user who joins while another user waits is paired with that user at once, so the queue holds at most one user.
- An event stores a move or an end only if the game still has the number of moves that the event read, and it pairs with a waiting user only if that user is still at the head of the queue. Otherwise the script stores nothing of the event, and the event reads again. An event tries at most three times, and after the third conflict it fails with `internalError`.
- The script of the end deletes the game, its deadline and the statuses that still name it, and it pushes the event of the end onto the outbox, which is the transaction of ADR-6. A later event of the game finds no game, and a move of the bot that comes after the end is dropped.
- Every game has one deadline, for the color whose turn it is, and the script of a move replaces it. For a user it is the time at which the clock runs out. The bot has no clock, so its deadline is 35 seconds after its turn began, which is the longest move request of ADR-6 with its repeat and the 5 seconds of a command.
- Once a second every instance looks for the deadlines that have passed, and the stored game decides what a passed deadline means. The game of a user whose clock has run out ends on time. A move of the bot that has not been stored in time is asked for again by the instance that claims the deadline, and the claim moves the deadline to 35 seconds later. A deadline stays until a move or the end of its game replaces it, so the handling of a deadline that fails is tried again later.
- A move that comes after the time of its user has run out ends the game on time too.
- Every 1.5 seconds every instance sends the events of the outbox to RabbitMQ from the oldest one, and it removes an event by its JSON once the broker has confirmed it.
- The ids of the games and of the events come from `randomUUIDv7` of `node:crypto`.
- The tests of `RedisService` run against Redis in a container that Testcontainers starts from the image of the infra compose, with the users of ADR-6 and an admin user, with which the tests prepare the data.

## Rationale

- Redis develops node-redis actively, and the README of ioredis recommends it for new projects, because ioredis is maintained on a best-effort basis. The base package brings only the client, as the service uses no module of Redis Stack.
- The documentation of Redis asks applications to run their scripts with EVALSHA, because EVAL sends the source with every call.
- A command that waited for the connection without a limit would carry out an event long after its client has stopped waiting for the answer. The 5 seconds, which are the default of node-redis 6, bridge a restart of Redis and stay below the 10 seconds after which the frontend gives up (FE-ADR-5).
- Redis runs a script as a whole and blocks every other command meanwhile, so no event sees half of a change, and the check and the change take one round trip. The documentation of Redis says that a script can do everything that a transaction can, and usually simpler and faster.
- The check of the number of moves is optimistic concurrency. Two events of one game rarely meet, so the event that came second reads again, instead of every event waiting for a lock. The number of moves is part of the game, so it needs no version of its own.
- Every event reads the game as a whole, and the scripts read the number of moves from its JSON with `cjson`, so one string per game is enough.
- A sorted set by the time of the deadlines gives the passed deadlines of every game with one range query, which any instance can run, as ADR-10 asks.
- The stored game decides whether a clock has run out, so a deadline that an instance read before a move replaced it ends nothing. The script of the end changes nothing in a game that has ended or changed, so an end that is tried again, or by two instances at the same time, ends the game once. A deadline of a clock therefore needs no claim, and a failure between the check and the end loses no deadline.
- A move request can be repeated at any time (ADR-6), so an instance that stops while the bot thinks only delays the move. The deadline of the bot lies after the longest time that a working instance needs, so the engine is asked a second time only after a failure.
- The claim moves the deadline in one script, so only one instance asks the engine again, and if that instance fails too, the moved deadline passes and the next one asks. This is how the visibility timeout of a queue such as Amazon SQS gives a message that was not processed to another consumer.
- An event leaves the outbox only after the broker has confirmed it, so neither a crash nor a broker that is down loses it. Two instances can send the same event, and the consumer of ADR-6 filters out the second one by its id.
- Node.js creates a UUID v7 of RFC 9562 since version 26.1, so the ids need no dependency.
- Only Redis runs the scripts, so a test with a mock of the client would pass a script with a wrong key. With the users of ADR-6 the tests also find a command that the user of the service may not run.

## Rejected alternatives

- **ioredis:** the service used it at first, but it is maintained on a best-effort basis, and its README recommends node-redis for new projects.
- **The package `redis`:** it is node-redis with the modules of Redis Stack, which the service does not use.
- **WATCH with MULTI and EXEC:** WATCH belongs to a connection, so every event that runs at the same time would need a connection of its own, and the check would cost another round trip.
- **Functions of Redis:** Redis keeps and replicates them, but they have to be loaded into Redis before the service uses them, and two versions of the service during an update would share one library. A script is part of the code of its version.
- **SET with IFEQ of Redis 8.4:** it compares the value of one key, while a move also changes the deadlines, and an end also changes the statuses and the outbox.
- **A lock for every game:** an instance that stops while it holds a lock blocks the game until the lock expires, and a lock with an expiry does not protect an instance that pauses for longer than the expiry.
- **A hash for every game:** every event reads the whole game, and the moves would need a list of their own, so a hash would only make the scripts longer.
- **Expiring keys with keyspace notifications:** Redis sends the event of an expired key only when it deletes the key, which can be much later, Pub/Sub loses the events while a subscriber is disconnected, and every instance would get every event.
- **A timer in the instance that stored the last move:** it would be lost with the instance, which ADR-3 does not allow.
- **The instance that removes a passed deadline ends the game:** the instances would not try the same end at the same time, but an instance that fails after the removal would leave the game without a deadline.
- **Ending a game as aborted when the bot has not moved in time:** simpler, but an instance that stops is no failure of the engine, and the user would lose a game that can go on.
- **The requests of the bot in a stream with a consumer group:** XAUTOCLAIM gives a request that its instance has not acknowledged to another instance, but the stream, its consumer group and the acknowledgements would be a second way next to the deadlines, which every instance checks already.
- **v7 of the `uuid` package:** it creates the same kind of ids with one more dependency to keep up to date.
- **Tests with a mock of the client:** they need no Docker, but they check only the arguments of the calls and not what the scripts do.

## Consequences

- The scripts use keys of several hash slots, so a Redis Cluster would need hash tags in the names of the keys.
- The times of the clocks and of the deadlines come from the instances, so the hosts of the instances need synchronized clocks, for example with NTP. A difference between two hosts changes the time of a move by the same amount.
- A game in which nobody moves ends up to a second after its time has run out.
- When the instance that asked the engine stops, the move of the bot comes 35 seconds after its turn began at the earliest, and the clock of the user stands still meanwhile, as ADR-10 asks while the bot thinks.
- An instance that is only slow can store the move of the bot after another instance has asked the engine again, and the move that comes second is dropped.
- The deadline of the bot follows from the time limits of the engine client and of the commands, so it changes with them.
- Every instance checks the deadlines and the outbox, so every new instance adds requests to Redis even while nothing happens.
- While the handling of a deadline keeps failing, every check tries it again and logs the error.
- The tests need Docker, locally and in the CI. The image and the users of ADR-6 in the tests are a copy of the compose of the infra repo, so a change of them is made in both places.
- The service needs Node.js 26.1 or newer.

## Sources

- node-redis, client configuration: https://github.com/redis/node-redis/blob/master/docs/client-configuration.md
- node-redis, command options and their timeout: https://github.com/redis/node-redis/blob/master/docs/command-options.md
- node-redis, Lua scripts: https://github.com/redis/node-redis/blob/master/docs/programmability.md
- ioredis: https://github.com/redis/ioredis
- Redis, scripting with Lua and the script cache: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Redis, functions: https://redis.io/docs/latest/develop/programmability/functions-intro/
- Redis, transactions: https://redis.io/docs/latest/develop/using-commands/transactions/
- Redis, keyspace notifications: https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/
- Redis, sorted sets: https://redis.io/docs/latest/develop/data-types/sorted-sets/
- Redis, XAUTOCLAIM: https://redis.io/docs/latest/commands/xautoclaim/
- Redis cluster specification, hash tags: https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags
- Amazon SQS visibility timeout: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- Martin Fowler, Optimistic Offline Lock: https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html
- Martin Kleppmann, How to do distributed locking: https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- Node.js, `crypto.randomUUIDv7`: https://nodejs.org/api/crypto.html#cryptorandomuuidv7options
- RFC 9562, UUID v7: https://www.rfc-editor.org/rfc/rfc9562
- Testcontainers for Node.js, Redis module: https://node.testcontainers.org/modules/redis/
