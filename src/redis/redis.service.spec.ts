import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisService } from './redis.service';
import { AppConfigService } from '../config/config.service';
import { GameState, UserPlayer } from '../domain/types';

describe('RedisService', () => {
  let service: RedisService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnThis(),
        del: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zrem: vi.fn().mockReturnThis(),
        lpush: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      zrangebyscore: vi.fn(),
      zrem: vi.fn(),
      rpop: vi.fn(),
      lpush: vi.fn(),
    };

    const mockConfig = {
      redisUrl: 'redis://localhost:6379',
    } as AppConfigService;

    service = new RedisService(mockConfig);
    service.setClient(mockRedis);
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

  it('prevents user from joining queue if already in queue', async () => {
    mockRedis.eval.mockResolvedValue(['error', 'alreadyInQueue']);
    const player: UserPlayer = {
      kind: 'user',
      userId: 'user-1',
      name: 'Alice',
    };
    const result = await service.joinQueue(player);
    expect(result.error).toBe('alreadyInQueue');
  });

  it('prevents user from joining queue if already in game', async () => {
    mockRedis.eval.mockResolvedValue(['error', 'alreadyInGame']);
    const player: UserPlayer = {
      kind: 'user',
      userId: 'user-1',
      name: 'Alice',
    };
    const result = await service.joinQueue(player);
    expect(result.error).toBe('alreadyInGame');
  });

  it('joins queue and matches two players when queue length reaches 2', async () => {
    const p1: UserPlayer = { kind: 'user', userId: 'user-1', name: 'Alice' };
    const p2: UserPlayer = { kind: 'user', userId: 'user-2', name: 'Bob' };

    mockRedis.eval.mockResolvedValue([
      'matched',
      JSON.stringify(p1),
      JSON.stringify(p2),
    ]);

    const result = await service.joinQueue(p2);
    expect(result.matched).toBeDefined();
    expect(result.matched![0].userId).toBe('user-1');
    expect(result.matched![1].userId).toBe('user-2');
  });

  it('leaves queue successfully when queued', async () => {
    mockRedis.get.mockResolvedValue('queue');
    mockRedis.eval.mockResolvedValue(1);

    const result = await service.leaveQueue('user-1');
    expect(result).toBe(true);
  });

  it('returns false when leaving queue if not in queue', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await service.leaveQueue('user-1');
    expect(result).toBe(false);
  });

  it('creates game and sets up pipeline commands', async () => {
    const game: GameState = {
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

    await service.createGame(game);
    const pipelineMock = mockRedis.pipeline();
    expect(pipelineMock.set).toHaveBeenCalledWith(
      'game:game-1',
      JSON.stringify(game),
    );
    expect(pipelineMock.set).toHaveBeenCalledWith(
      'user:status:user-1',
      'game:game-1',
    );
    expect(pipelineMock.set).toHaveBeenCalledWith(
      'user:status:user-2',
      'game:game-1',
    );
    expect(pipelineMock.zadd).toHaveBeenCalled();
  });
});
