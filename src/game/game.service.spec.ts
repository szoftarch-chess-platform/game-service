import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GameService, ExtendedGameState } from './game.service';
import { RedisService } from '../redis/redis.service';
import { EngineClient } from '../engine/engine.client';
import { UserPlayer } from '../domain/types';

describe('GameService', () => {
  let service: GameService;
  let mockRedis: any;
  let mockEngine: any;
  let mockServer: any;

  beforeEach(() => {
    mockRedis = {
      getUserStatus: vi.fn(),
      joinQueue: vi.fn(),
      leaveQueue: vi.fn(),
      createGame: vi.fn(),
      getGame: vi.fn(),
      saveGameState: vi.fn(),
    };

    mockEngine = {
      requestMove: vi.fn(),
    };

    mockServer = {
      to: vi.fn().mockReturnValue({
        emit: vi.fn(),
      }),
    };

    service = new GameService(
      mockRedis as RedisService,
      mockEngine as EngineClient,
    );
    service.setServer(mockServer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('joinQueue & leaveQueue', () => {
    it('successfully joins queue when free', async () => {
      mockRedis.joinQueue.mockResolvedValue({});
      const res = await service.joinQueue('user-1', 'Alice');
      expect(res.ok).toBe(true);
      expect(mockRedis.joinQueue).toHaveBeenCalledWith({
        kind: 'user',
        userId: 'user-1',
        name: 'Alice',
      });
    });

    it('rejects if already in queue', async () => {
      mockRedis.joinQueue.mockResolvedValue({ error: 'alreadyInQueue' });
      const res = await service.joinQueue('user-1', 'Alice');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('alreadyInQueue');
      }
    });

    it('pairs two players and starts PvP game when matched', async () => {
      const p1: UserPlayer = { kind: 'user', userId: 'user-1', name: 'Alice' };
      const p2: UserPlayer = { kind: 'user', userId: 'user-2', name: 'Bob' };
      mockRedis.joinQueue.mockResolvedValue({ matched: [p1, p2] });

      const res = await service.joinQueue('user-2', 'Bob');
      expect(res.ok).toBe(true);
      expect(mockRedis.createGame).toHaveBeenCalled();
      expect(mockServer.to).toHaveBeenCalledWith('user:user-1');
      expect(mockServer.to).toHaveBeenCalledWith('user:user-2');
    });

    it('leaves queue successfully', async () => {
      mockRedis.leaveQueue.mockResolvedValue(true);
      const res = await service.leaveQueue('user-1');
      expect(res.ok).toBe(true);
    });

    it('rejects leaveQueue if not in queue', async () => {
      mockRedis.leaveQueue.mockResolvedValue(false);
      const res = await service.leaveQueue('user-1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('notInQueue');
      }
    });
  });

  describe('startBotGame', () => {
    it('creates game against bot and broadcasts gameStarted', async () => {
      mockRedis.getUserStatus.mockResolvedValue({ status: 'idle' });
      const res = await service.startBotGame('user-1', 'Alice');
      expect(res.ok).toBe(true);
      expect(mockRedis.createGame).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'standard',
          timeControl: { initialMs: 600000 },
        }),
      );
      expect(mockServer.to).toHaveBeenCalledWith('user:user-1');
    });

    it('rejects if user is already in game', async () => {
      mockRedis.getUserStatus.mockResolvedValue({ status: 'game' });
      const res = await service.startBotGame('user-1', 'Alice');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('alreadyInGame');
      }
    });
  });

  describe('makeMove', () => {
    const activeGame: ExtendedGameState = {
      gameId: 'game-1',
      variant: 'standard',
      white: { kind: 'user', userId: 'user-1', name: 'Alice' },
      black: { kind: 'user', userId: 'user-2', name: 'Bob' },
      timeControl: { initialMs: 600000 },
      startedAt: new Date().toISOString(),
      moves: [],
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      clock: { whiteMs: 600000, blackMs: 600000, running: 'white' },
      lastMoveTimestamp: Date.now(),
    };

    it('rejects move if game not found', async () => {
      mockRedis.getGame.mockResolvedValue(null);
      const res = await service.makeMove('user-1', 'game-x', 'e2e4');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('gameNotFound');
      }
    });

    it('rejects move if not player in game', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      const res = await service.makeMove('user-3', 'game-1', 'e2e4');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('gameNotFound');
      }
    });

    it('rejects move if not user turn', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      // It is white's turn, so Bob (black) cannot move
      const res = await service.makeMove('user-2', 'game-1', 'e7e5');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('notYourTurn');
      }
    });

    it('rejects illegal move', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      const res = await service.makeMove('user-1', 'game-1', 'e2e5');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('illegalMove');
      }
    });

    it('accepts legal move, updates clock and state, broadcasts moveMade', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      const res = await service.makeMove('user-1', 'game-1', 'e2e4');
      expect(res.ok).toBe(true);
      expect(mockRedis.saveGameState).toHaveBeenCalledWith(
        expect.objectContaining({
          moves: ['e2e4'],
          clock: expect.objectContaining({
            running: 'black',
          }),
        }),
        false,
      );
      expect(mockServer.to).toHaveBeenCalled();
    });
  });

  describe('resign', () => {
    const activeGame: ExtendedGameState = {
      gameId: 'game-1',
      variant: 'standard',
      white: { kind: 'user', userId: 'user-1', name: 'Alice' },
      black: { kind: 'user', userId: 'user-2', name: 'Bob' },
      timeControl: { initialMs: 600000 },
      startedAt: new Date().toISOString(),
      moves: [],
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      clock: { whiteMs: 600000, blackMs: 600000, running: 'white' },
      lastMoveTimestamp: Date.now(),
    };

    it('handles resignation and ends game with opponent win', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      const res = await service.resign('user-1', 'game-1');
      expect(res.ok).toBe(true);
      expect(mockRedis.saveGameState).toHaveBeenCalledWith(
        expect.any(Object),
        true,
        expect.objectContaining({
          type: 'game.finished.v1',
          data: expect.objectContaining({
            result: 'blackWon',
            reason: 'resignation',
          }),
        }),
      );
    });
  });

  describe('getState', () => {
    it('returns queued: true when user is in queue', async () => {
      mockRedis.getUserStatus.mockResolvedValue({ status: 'queue' });
      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.queued).toBe(true);
    });

    it('returns active game when user is in game', async () => {
      const activeGame = { gameId: 'g1' } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.queued).toBe(false);
      expect(res.game).toEqual(activeGame);
    });

    it('subtracts elapsed time from the running side clock in getState', async () => {
      const now = Date.now();
      const activeGame = {
        gameId: 'g1',
        variant: 'standard',
        startedAt: new Date(now - 10000).toISOString(),
        lastMoveTimestamp: now - 5000,
        clock: {
          initialMs: 600000,
          whiteMs: 600000,
          blackMs: 600000,
          running: 'white',
        },
      } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.queued).toBe(false);
      expect(res.game?.clock.running).toBe('white');
      expect(res.game?.clock.whiteMs).toBeLessThanOrEqual(595000);
      expect(res.game?.clock.whiteMs).toBeGreaterThan(590000);
      expect(res.game?.clock.blackMs).toBe(600000);
    });

    it('subtracts elapsed time from the black running side clock in getState', async () => {
      const now = Date.now();
      const activeGame = {
        gameId: 'g1',
        variant: 'standard',
        startedAt: new Date(now - 10000).toISOString(),
        lastMoveTimestamp: now - 3000,
        clock: {
          initialMs: 600000,
          whiteMs: 580000,
          blackMs: 590000,
          running: 'black',
        },
      } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.game?.clock.running).toBe('black');
      expect(res.game?.clock.whiteMs).toBe(580000);
      expect(res.game?.clock.blackMs).toBeLessThanOrEqual(587000);
      expect(res.game?.clock.blackMs).toBeGreaterThan(580000);
    });

    it('clamps remaining clock to 0 when elapsed time exceeds clock in getState', async () => {
      const now = Date.now();
      const activeGame = {
        gameId: 'g1',
        variant: 'standard',
        startedAt: new Date(now - 20000).toISOString(),
        lastMoveTimestamp: now - 15000,
        clock: {
          initialMs: 600000,
          whiteMs: 5000, // 5s left, but 15s elapsed
          blackMs: 600000,
          running: 'white',
        },
      } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.game?.clock.whiteMs).toBe(0);
    });

    it('falls back to startedAt when lastMoveTimestamp is undefined', async () => {
      const now = Date.now();
      const activeGame = {
        gameId: 'g1',
        variant: 'standard',
        startedAt: new Date(now - 4000).toISOString(),
        clock: {
          initialMs: 600000,
          whiteMs: 600000,
          blackMs: 600000,
          running: 'white',
        },
      } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.game?.clock.whiteMs).toBeLessThanOrEqual(596000);
      expect(res.game?.clock.whiteMs).toBeGreaterThan(590000);
    });

    it('does not deduct time when clock is not running', async () => {
      const now = Date.now();
      const activeGame = {
        gameId: 'g1',
        variant: 'standard',
        startedAt: new Date(now - 10000).toISOString(),
        lastMoveTimestamp: now - 5000,
        clock: {
          initialMs: 600000,
          whiteMs: 500000,
          blackMs: 500000,
        },
      } as any;
      mockRedis.getUserStatus.mockResolvedValue({
        status: 'game',
        gameId: 'g1',
      });
      mockRedis.getGame.mockResolvedValue(activeGame);

      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.game?.clock.whiteMs).toBe(500000);
      expect(res.game?.clock.blackMs).toBe(500000);
    });

    it('returns queued: false when idle', async () => {
      mockRedis.getUserStatus.mockResolvedValue({ status: 'idle' });
      const res = await service.getState('user-1');
      expect(res.ok).toBe(true);
      expect(res.queued).toBe(false);
      expect(res.game).toBeUndefined();
    });
  });
});
