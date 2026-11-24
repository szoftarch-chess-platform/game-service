import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisService } from './redis.service';
import { AppConfigService } from '../config/config.service';
import { GameFinishedEvent, GameState, UserPlayer } from '../domain/types';

/** The commands of a pipeline or a transaction, which ioredis chains until exec. */
function commandChain() {
  return {
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zrem: vi.fn().mockReturnThis(),
    lpush: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
}

function newGame(): GameState {
  return {
    gameId: 'game-1',
    variant: 'standard',
    white: { kind: 'user', userId: 'user-1', name: 'Alice' },
    black: { kind: 'user', userId: 'user-2', name: 'Bob' },
    timeControl: { initialMs: 600000 },
    startedAt: '2026-11-21T00:00:00.000Z',
    moves: [],
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    clock: { whiteMs: 600000, blackMs: 600000, running: 'white' },
  };
}

function finishedEvent(game: GameState): GameFinishedEvent {
  return {
    id: '0193c2c0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    type: 'game.finished.v1',
    source: 'game-service',
    time: '2026-11-21T00:10:00.000Z',
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
      endedAt: '2026-11-21T00:10:00.000Z',
    },
  };
}

describe('RedisService', () => {
  let service: RedisService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi.fn(),
      pipeline: vi.fn().mockReturnValue(commandChain()),
      multi: vi.fn().mockReturnValue(commandChain()),
      zrangebyscore: vi.fn(),
      zrem: vi.fn(),
      lindex: vi.fn(),
      lrem: vi.fn(),
      lpush: vi.fn(),
    };

    const mockConfig = {
      redisUrl: 'redis://localhost:6379',
    } as AppConfigService;

    service = new RedisService(mockConfig);
    service.setClient(mockRedis);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports user as idle when no status key is found', async () => {
    mockRedis.get.mockResolvedValue(null);
    const status = await service.getUserStatus('user-1');
    expect(status.status).toBe('idle');
  });

  it('reports user as in queue when status is queue', async () => {
    mockRedis.get.mockResolvedValue('queue');
    const status = await service.getUserStatus('user-1');
    expect(status.status).toBe('queue');
  });

  it('reports user as in game when status is game:id', async () => {
    mockRedis.get.mockResolvedValue(
      'game:0193c2bf-0a1b-7c2d-9e3f-4a5b6c7d8e9f',
    );
    const status = await service.getUserStatus('user-1');
    expect(status.status).toBe('game');
    expect(status.gameId).toBe('0193c2bf-0a1b-7c2d-9e3f-4a5b6c7d8e9f');
  });

  it('refuses a user who waits or plays already, as the script answers', async () => {
    mockRedis.eval.mockResolvedValue('alreadyInGame');
    const player: UserPlayer = {
      kind: 'user',
      userId: 'user-1',
      name: 'Alice',
    };

    await expect(service.joinQueue(player)).resolves.toBe('alreadyInGame');
  });

  it('reads the head of the queue with the JSON that the queue holds', async () => {
    const json = JSON.stringify({
      kind: 'user',
      userId: 'user-1',
      name: 'Alice',
    });
    mockRedis.lindex.mockResolvedValue(json);

    await expect(service.peekQueue()).resolves.toEqual({
      json,
      player: { kind: 'user', userId: 'user-1', name: 'Alice' },
    });
    expect(mockRedis.lindex).toHaveBeenCalledWith('queue:players', 0);
  });

  it('finds nobody at the head of an empty queue', async () => {
    mockRedis.lindex.mockResolvedValue(null);

    await expect(service.peekQueue()).resolves.toBeUndefined();
  });

  it('joins an empty queue with the status and the queue only', async () => {
    const player: UserPlayer = { kind: 'user', userId: 'user-2', name: 'Bob' };
    mockRedis.eval.mockResolvedValue('queued');

    await expect(service.joinQueue(player)).resolves.toBe('queued');

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('RPUSH', KEYS[2], ARGV[1])"),
      2,
      'user:status:user-2',
      'queue:players',
      JSON.stringify(player),
      '',
    );
  });

  it('pairs with the waiting user and stores the game in the same script', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const game = newGame();
    const waiting = {
      json: JSON.stringify(game.white),
      player: game.white as UserPlayer,
    };
    mockRedis.eval.mockResolvedValue('matched');

    await expect(
      service.joinQueue(game.black as UserPlayer, { waiting, game }),
    ).resolves.toBe('matched');

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[4], ARGV[3])"),
      5,
      'user:status:user-2',
      'queue:players',
      'user:status:user-1',
      'game:game-1',
      'game:deadlines',
      JSON.stringify(game.black),
      waiting.json,
      JSON.stringify(game),
      'game-1',
      'game-1:white',
      601000,
    );
  });

  it('leaves the queue only while the script finds the user waiting', async () => {
    mockRedis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.leaveQueue('user-1')).resolves.toBe(true);
    await expect(service.leaveQueue('user-1')).resolves.toBe(false);

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("~= 'queue'"),
      2,
      'user:status:user-1',
      'queue:players',
      'user-1',
    );
  });

  it('starts a game against the bot with the status of the user in one script', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const game = newGame();
    game.black = { kind: 'bot', name: 'Stockfish bot' };
    game.clock = { whiteMs: 600000, running: 'white' };
    mockRedis.eval.mockResolvedValue('started');

    await expect(service.startGame('user-1', game)).resolves.toBeUndefined();

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("return 'started'"),
      3,
      'user:status:user-1',
      'game:game-1',
      'game:deadlines',
      JSON.stringify(game),
      'game-1',
      'game-1:white',
      601000,
    );
  });

  it('starts a game in which the bot moves first without a deadline', async () => {
    const game = newGame();
    game.white = { kind: 'bot', name: 'Stockfish bot' };
    game.clock = { blackMs: 600000 };
    mockRedis.eval.mockResolvedValue('started');

    await service.startGame('user-2', game);

    expect(mockRedis.eval.mock.calls[0].slice(-2)).toEqual(['', 0]);
  });

  it('returns the refusal of a user who is not free', async () => {
    mockRedis.eval.mockResolvedValue('alreadyInQueue');

    await expect(service.startGame('user-1', newGame())).resolves.toBe(
      'alreadyInQueue',
    );
  });

  it('saves a move with the deadline of the running clock in one script', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const game = newGame();
    game.moves = ['e2e4'];
    game.clock = { whiteMs: 590000, blackMs: 600000, running: 'black' };
    mockRedis.eval.mockResolvedValue(1);

    await expect(service.saveMove(game, 0)).resolves.toBe(true);

    expect(mockRedis.multi).not.toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[1], ARGV[2])"),
      2,
      'game:game-1',
      'game:deadlines',
      0,
      JSON.stringify(game),
      'game-1',
      'game-1:black',
      601000,
    );
  });

  it('saves a move without a deadline while the bot thinks', async () => {
    const game = newGame();
    game.black = { kind: 'bot', name: 'Stockfish bot' };
    game.clock = { whiteMs: 590000 };
    mockRedis.eval.mockResolvedValue(1);

    await service.saveMove(game, 0);

    const args = mockRedis.eval.mock.calls[0];
    expect(args.slice(-2)).toEqual(['', 0]);
  });

  it('reports a move that the script refused because the game changed', async () => {
    mockRedis.eval.mockResolvedValue(0);

    await expect(service.saveMove(newGame(), 0)).resolves.toBe(false);
  });

  it('finishes a game with its outbox event in one script', async () => {
    const game = newGame();
    const event = finishedEvent(game);
    mockRedis.eval.mockResolvedValue(1);

    await expect(service.finishGame(game, 0, event)).resolves.toBe(true);

    expect(mockRedis.multi).not.toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('LPUSH', KEYS[3], ARGV[2])"),
      5,
      'game:game-1',
      'game:deadlines',
      'outbox:events',
      'user:status:user-1',
      'user:status:user-2',
      0,
      JSON.stringify(event),
      'game-1',
    );
  });

  it('passes only the status of the user to the script in a game against the bot', async () => {
    const game = newGame();
    game.white = { kind: 'bot', name: 'Stockfish bot' };
    mockRedis.eval.mockResolvedValue(1);

    await service.finishGame(game, 0, finishedEvent(game));

    const args = mockRedis.eval.mock.calls[0];
    expect(args[1]).toBe(4);
    expect(args.slice(2, 6)).toEqual([
      'game:game-1',
      'game:deadlines',
      'outbox:events',
      'user:status:user-2',
    ]);
  });

  it('reports a game that has ended or changed already', async () => {
    const game = newGame();
    mockRedis.eval.mockResolvedValue(0);

    await expect(
      service.finishGame(game, 0, finishedEvent(game)),
    ).resolves.toBe(false);
  });

  it('returns the oldest outbox event without removing it', async () => {
    const event = finishedEvent(newGame());
    const json = JSON.stringify(event);
    mockRedis.lindex.mockResolvedValue(json);

    await expect(service.peekOutboxEvent()).resolves.toEqual({ json, event });

    expect(mockRedis.lindex).toHaveBeenCalledWith('outbox:events', -1);
    expect(mockRedis.lrem).not.toHaveBeenCalled();
  });

  it('returns null when the outbox is empty', async () => {
    mockRedis.lindex.mockResolvedValue(null);

    await expect(service.peekOutboxEvent()).resolves.toBeNull();
  });

  it('removes a confirmed event by its stored JSON', async () => {
    const json = JSON.stringify(finishedEvent(newGame()));

    await service.removeOutboxEvent(json);

    expect(mockRedis.lrem).toHaveBeenCalledWith('outbox:events', -1, json);
  });
});
