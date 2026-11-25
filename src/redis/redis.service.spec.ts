import { randomUUID } from 'node:crypto';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/config.service';
import { ChessRules } from '../domain/chess-rules';
import {
  BotPlayer,
  GameFinishedEvent,
  GameState,
  Player,
  UserPlayer,
} from '../domain/types';
import { RedisService } from './redis.service';

// The image of Redis in the compose of the infra repo (ADR-6).
const REDIS_IMAGE = 'redis:8.8-alpine';

// The first start pulls the image, which can take long.
const START_TIMEOUT_MS = 120_000;

const INITIAL_MS = 600_000;

function user(name: string): UserPlayer {
  return { kind: 'user', userId: `id-${name}`, name };
}

const alice = user('alice');
const bob = user('bob');
const carol = user('carol');
const bot: BotPlayer = { kind: 'bot', name: 'Stockfish bot' };

function newGame(white: Player, black: Player): GameState {
  return {
    gameId: randomUUID(),
    variant: 'standard',
    white,
    black,
    timeControl: { initialMs: INITIAL_MS },
    startedAt: new Date().toISOString(),
    moves: [],
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    clock: ChessRules.createInitialClock(white, black, INITIAL_MS),
  };
}

function finishedEvent(game: GameState): GameFinishedEvent {
  const endedAt = new Date().toISOString();
  return {
    id: randomUUID(),
    type: 'game.finished.v1',
    source: 'game-service',
    time: endedAt,
    data: {
      gameId: game.gameId,
      variant: game.variant,
      white: game.white,
      black: game.black,
      result: 'whiteWon',
      reason: 'resignation',
      moves: game.moves,
      timeControl: game.timeControl,
      startedAt: game.startedAt,
      endedAt,
    },
  };
}

/** Starts Redis with the users of the infra compose, in which only the user of the service can sign in (ADR-6). */
function startRedis(password: string): Promise<StartedRedisContainer> {
  return new RedisContainer(REDIS_IMAGE)
    .withCommand([
      'redis-server',
      '--user',
      'default',
      'off',
      '--user',
      'game-service',
      'on',
      `>${password}`,
      '~*',
      '&*',
      '+@all',
      '-@admin',
    ])
    .start();
}

describe('RedisService against Redis', () => {
  let container: StartedRedisContainer;
  let service: RedisService;
  // A connection of its own, with which a test prepares and reads what the service cannot.
  let redis: Redis;

  beforeAll(async () => {
    const password = randomUUID();
    container = await startRedis(password);
    const url = `redis://game-service:${password}@${container.getHost()}:${container.getPort()}`;
    service = new RedisService({ redisUrl: url } as AppConfigService);
    service.onModuleInit();
    redis = new Redis(url);
  }, START_TIMEOUT_MS);

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await service?.onModuleDestroy();
    await redis?.quit();
    await container?.stop();
  });

  /** Pairs two users through the queue, and the one who waited plays white. */
  async function pair(waiting: UserPlayer, next: UserPlayer) {
    await service.joinQueue(waiting);
    const head = await service.peekQueue();
    const game = newGame(waiting, next);
    await expect(
      service.joinQueue(next, { waiting: head!, game }),
    ).resolves.toBe('matched');
    return game;
  }

  /** Every clock that runs, whenever it runs out. */
  const runningClocks = () => service.getExpiredClocks(Number.MAX_SAFE_INTEGER);

  describe('the queue', () => {
    it('takes a free user only once', async () => {
      await expect(service.joinQueue(alice)).resolves.toBe('queued');
      await expect(service.joinQueue(alice)).resolves.toBe('alreadyInQueue');

      await expect(service.getUserStatus(alice.userId)).resolves.toEqual({
        status: 'queue',
      });
      await expect(service.peekQueue()).resolves.toEqual({
        json: JSON.stringify(alice),
        player: alice,
      });
    });

    it('pairs the next user with the head and stores their game with the clock of white', async () => {
      const game = await pair(alice, bob);

      await expect(service.peekQueue()).resolves.toBeUndefined();
      const playing = { status: 'game', gameId: game.gameId };
      await expect(service.getUserStatus(alice.userId)).resolves.toEqual(
        playing,
      );
      await expect(service.getUserStatus(bob.userId)).resolves.toEqual(playing);
      await expect(service.getGame(game.gameId)).resolves.toEqual(game);
      await expect(runningClocks()).resolves.toEqual([
        { gameId: game.gameId, color: 'white' },
      ]);
      await expect(service.joinQueue(alice)).resolves.toBe('alreadyInGame');
    });

    it('changes nothing when the head has left since it was read', async () => {
      await service.joinQueue(alice);
      const head = await service.peekQueue();
      await service.leaveQueue(alice.userId);

      await expect(
        service.joinQueue(bob, { waiting: head!, game: newGame(alice, bob) }),
      ).resolves.toBe('queueChanged');

      await expect(service.getUserStatus(bob.userId)).resolves.toEqual({
        status: 'idle',
      });
      await expect(service.peekQueue()).resolves.toBeUndefined();
    });

    it('pairs a waiting user with only one of two users who join at the same time', async () => {
      await service.joinQueue(alice);
      const head = await service.peekQueue();

      const outcomes = await Promise.all([
        service.joinQueue(bob, { waiting: head!, game: newGame(alice, bob) }),
        service.joinQueue(carol, {
          waiting: head!,
          game: newGame(alice, carol),
        }),
      ]);

      expect(outcomes).toEqual(['matched', 'queueChanged']);
      await expect(service.getUserStatus(carol.userId)).resolves.toEqual({
        status: 'idle',
      });
    });

    it('drops a head whose user does not wait any more', async () => {
      // Only a status that something else than the scripts deleted leaves such a head.
      await service.joinQueue(alice);
      await redis.del(`user:status:${alice.userId}`);
      const head = await service.peekQueue();

      await expect(
        service.joinQueue(bob, { waiting: head!, game: newGame(alice, bob) }),
      ).resolves.toBe('queueChanged');

      await expect(service.peekQueue()).resolves.toBeUndefined();
      await expect(service.getUserStatus(bob.userId)).resolves.toEqual({
        status: 'idle',
      });
    });

    it('queues nobody behind a waiting user', async () => {
      await service.joinQueue(alice);

      await expect(service.joinQueue(bob)).resolves.toBe('queueChanged');

      await expect(service.getUserStatus(bob.userId)).resolves.toEqual({
        status: 'idle',
      });
      await expect(service.peekQueue()).resolves.toMatchObject({
        player: alice,
      });
    });

    it('lets a waiting user leave once', async () => {
      await service.joinQueue(alice);

      await expect(service.leaveQueue(alice.userId)).resolves.toBe(true);
      await expect(service.leaveQueue(alice.userId)).resolves.toBe(false);

      await expect(service.getUserStatus(alice.userId)).resolves.toEqual({
        status: 'idle',
      });
      await expect(service.peekQueue()).resolves.toBeUndefined();
    });
  });

  describe('a game against the bot', () => {
    it('starts only for a free user', async () => {
      const game = newGame(alice, bot);
      await expect(
        service.startGame(alice.userId, game),
      ).resolves.toBeUndefined();
      await expect(
        service.startGame(alice.userId, newGame(alice, bot)),
      ).resolves.toBe('alreadyInGame');

      await service.joinQueue(bob);
      const refused = newGame(bob, bot);
      await expect(service.startGame(bob.userId, refused)).resolves.toBe(
        'alreadyInQueue',
      );

      await expect(service.getGame(refused.gameId)).resolves.toBeNull();
      await expect(service.getUserStatus(alice.userId)).resolves.toEqual({
        status: 'game',
        gameId: game.gameId,
      });
      await expect(runningClocks()).resolves.toEqual([
        { gameId: game.gameId, color: 'white' },
      ]);
    });

    it('makes one game of two starts at the same time', async () => {
      const games = [newGame(alice, bot), newGame(bot, alice)];

      const refusals = await Promise.all(
        games.map((game) => service.startGame(alice.userId, game)),
      );

      expect(refusals).toEqual([undefined, 'alreadyInGame']);
      await expect(service.getGame(games[1].gameId)).resolves.toBeNull();
    });

    it('has no deadline while the bot thinks', async () => {
      await service.startGame(alice.userId, newGame(bot, alice));

      const game = newGame(bob, bot);
      await service.startGame(bob.userId, game);
      const moved: GameState = {
        ...game,
        moves: ['e2e4'],
        clock: { whiteMs: 590_000 },
      };
      await expect(service.saveMove(moved, 0)).resolves.toBe(true);

      await expect(runningClocks()).resolves.toEqual([]);
    });
  });

  describe('a move', () => {
    it('is stored only on the number of moves that it read and moves the deadline to the other clock', async () => {
      const game = await pair(alice, bob);
      const moved: GameState = {
        ...game,
        moves: ['e2e4'],
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        clock: { whiteMs: 590_000, blackMs: INITIAL_MS, running: 'black' },
      };

      await expect(service.saveMove(moved, 0)).resolves.toBe(true);
      await expect(service.saveMove(moved, 0)).resolves.toBe(false);

      await expect(service.getGame(game.gameId)).resolves.toEqual(moved);
      await expect(runningClocks()).resolves.toEqual([
        { gameId: game.gameId, color: 'black' },
      ]);
    });
  });

  describe('the clocks', () => {
    it('run out when the time that their side has left has passed', async () => {
      const before = Date.now();
      const game = await pair(alice, bob);
      const after = Date.now();

      await expect(
        service.getExpiredClocks(before + INITIAL_MS - 1),
      ).resolves.toEqual([]);
      await expect(
        service.getExpiredClocks(after + INITIAL_MS),
      ).resolves.toEqual([{ gameId: game.gameId, color: 'white' }]);
    });
  });

  describe('the end of a game', () => {
    it('happens once, frees the users and puts the event into the outbox', async () => {
      const game = await pair(alice, bob);
      const event = finishedEvent(game);

      await expect(service.finishGame(game, 1, event)).resolves.toBe(false);
      await expect(service.peekOutboxEvent()).resolves.toBeNull();

      await expect(service.finishGame(game, 0, event)).resolves.toBe(true);
      await expect(
        service.finishGame(game, 0, finishedEvent(game)),
      ).resolves.toBe(false);
      await expect(service.saveMove(game, 0)).resolves.toBe(false);

      await expect(service.getGame(game.gameId)).resolves.toBeNull();
      await expect(service.getUserStatus(alice.userId)).resolves.toEqual({
        status: 'idle',
      });
      await expect(service.getUserStatus(bob.userId)).resolves.toEqual({
        status: 'idle',
      });
      await expect(runningClocks()).resolves.toEqual([]);
      await expect(service.peekOutboxEvent()).resolves.toEqual({
        json: JSON.stringify(event),
        event,
      });
    });

    it('frees the user of a game against the bot', async () => {
      const game = newGame(alice, bot);
      await service.startGame(alice.userId, game);

      await expect(
        service.finishGame(game, 0, finishedEvent(game)),
      ).resolves.toBe(true);

      await expect(service.getUserStatus(alice.userId)).resolves.toEqual({
        status: 'idle',
      });
    });

    it('keeps a status that names another game', async () => {
      // Only a status that something else than the scripts changed names another game.
      const game = await pair(alice, bob);
      await redis.set(`user:status:${bob.userId}`, 'game:other');

      await service.finishGame(game, 0, finishedEvent(game));

      await expect(service.getUserStatus(bob.userId)).resolves.toEqual({
        status: 'game',
        gameId: 'other',
      });
    });
  });

  describe('the outbox', () => {
    it('returns the oldest event first and removes only the confirmed one', async () => {
      const games = [newGame(alice, bot), newGame(bob, bot)];
      await service.startGame(alice.userId, games[0]);
      await service.startGame(bob.userId, games[1]);
      const [older, newer] = games.map(finishedEvent);
      await service.finishGame(games[0], 0, older);
      await service.finishGame(games[1], 0, newer);

      await expect(service.peekOutboxEvent()).resolves.toMatchObject({
        event: older,
      });
      await service.removeOutboxEvent(JSON.stringify(older));
      // Another instance that has published the same event removes nothing more.
      await service.removeOutboxEvent(JSON.stringify(older));
      await expect(service.peekOutboxEvent()).resolves.toMatchObject({
        event: newer,
      });
    });
  });
});
