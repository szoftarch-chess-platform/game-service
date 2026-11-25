import { randomInt } from 'node:crypto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GameService, ExtendedGameState } from './game.service';
import { COMMAND_TIMEOUT_MS, RedisService } from '../redis/redis.service';
import { EngineClient, MAX_MOVE_REQUEST_MS } from '../engine/engine.client';
import { UserPlayer } from '../domain/types';

// The colors stay random unless a test chooses them.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

// The time by which the bot has to have moved.
const BOT_MOVE_DEADLINE_MS = MAX_MOVE_REQUEST_MS + COMMAND_TIMEOUT_MS;

describe('GameService', () => {
  let service: GameService;
  let mockRedis: any;
  let mockEngine: any;
  let mockServer: any;

  beforeEach(() => {
    mockRedis = {
      getUserStatus: vi.fn(),
      peekQueue: vi.fn().mockResolvedValue(undefined),
      joinQueue: vi.fn(),
      leaveQueue: vi.fn(),
      startGame: vi.fn().mockResolvedValue(undefined),
      getGame: vi.fn(),
      saveMove: vi.fn().mockResolvedValue(true),
      finishGame: vi.fn().mockResolvedValue(true),
      claimDeadline: vi.fn().mockResolvedValue(true),
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
    const alice: UserPlayer = { kind: 'user', userId: 'user-1', name: 'Alice' };
    const bob: UserPlayer = { kind: 'user', userId: 'user-2', name: 'Bob' };

    it('successfully joins queue when free', async () => {
      mockRedis.joinQueue.mockResolvedValue('queued');
      const res = await service.joinQueue('user-1', 'Alice');
      expect(res.ok).toBe(true);
      expect(mockRedis.joinQueue).toHaveBeenCalledWith(alice, undefined);
    });

    it('rejects if already in queue', async () => {
      mockRedis.joinQueue.mockResolvedValue('alreadyInQueue');
      const res = await service.joinQueue('user-1', 'Alice');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('alreadyInQueue');
      }
    });

    it('pairs with the waiting user in a game that the same script stores', async () => {
      const waiting = { json: JSON.stringify(alice), player: alice };
      mockRedis.peekQueue.mockResolvedValue(waiting);
      mockRedis.joinQueue.mockResolvedValue('matched');

      const res = await service.joinQueue('user-2', 'Bob');

      expect(res.ok).toBe(true);
      const [player, pairing] = mockRedis.joinQueue.mock.calls[0];
      expect(player).toEqual(bob);
      expect(pairing.waiting).toBe(waiting);
      expect([pairing.game.white, pairing.game.black]).toEqual(
        expect.arrayContaining([alice, bob]),
      );
      expect(pairing.game.clock).toEqual({
        whiteMs: 600000,
        blackMs: 600000,
        running: 'white',
      });
      expect(pairing.deadline).toEqual({
        color: 'white',
        at: pairing.game.lastMoveTimestamp + 600000,
      });
      expect(mockServer.to).toHaveBeenCalledWith('user:user-1');
      expect(mockServer.to).toHaveBeenCalledWith('user:user-2');
    });

    it('reads the queue again when it changed after it was read', async () => {
      mockRedis.peekQueue
        .mockResolvedValueOnce({ json: JSON.stringify(alice), player: alice })
        .mockResolvedValueOnce(undefined);
      mockRedis.joinQueue
        .mockResolvedValueOnce('queueChanged')
        .mockResolvedValueOnce('queued');

      const res = await service.joinQueue('user-2', 'Bob');

      expect(res.ok).toBe(true);
      expect(mockRedis.peekQueue).toHaveBeenCalledTimes(2);
      expect(mockRedis.joinQueue).toHaveBeenLastCalledWith(bob, undefined);
      expect(mockServer.to).not.toHaveBeenCalled();
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
      mockEngine.requestMove.mockResolvedValue({ success: false });
      const res = await service.startBotGame('user-1', 'Alice');
      expect(res.ok).toBe(true);
      expect(mockRedis.startGame).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          variant: 'standard',
          timeControl: { initialMs: 600000 },
        }),
        { color: 'white', at: expect.any(Number) },
      );
      expect(mockServer.to).toHaveBeenCalledWith('user:user-1');
    });

    it('gives the first move of the bot a deadline when the bot plays white', async () => {
      vi.mocked(randomInt).mockImplementationOnce(() => 1);
      mockEngine.requestMove.mockReturnValue(new Promise(() => {}));

      await service.startBotGame('user-1', 'Alice');

      const [, game, deadline] = mockRedis.startGame.mock.calls[0];
      expect(game.white.kind).toBe('bot');
      expect(deadline).toEqual({
        color: 'white',
        at: game.lastMoveTimestamp + BOT_MOVE_DEADLINE_MS,
      });
      expect(mockEngine.requestMove).toHaveBeenCalled();
    });

    it('rejects if user is already in game and starts nothing', async () => {
      mockRedis.startGame.mockResolvedValue('alreadyInGame');
      const res = await service.startBotGame('user-1', 'Alice');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('alreadyInGame');
      }
      expect(mockServer.to).not.toHaveBeenCalled();
      expect(mockEngine.requestMove).not.toHaveBeenCalled();
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

    it.each([
      {
        refusal: 'a move in a game that does not exist',
        game: null,
        userId: 'user-1',
        move: 'e2e4',
        code: 'gameNotFound',
      },
      {
        refusal: 'a move of a user who does not play the game',
        game: activeGame,
        userId: 'user-3',
        move: 'e2e4',
        code: 'gameNotFound',
      },
      {
        // It is the turn of white, so Bob, who plays black, cannot move.
        refusal: 'a move out of turn',
        game: activeGame,
        userId: 'user-2',
        move: 'e7e5',
        code: 'notYourTurn',
      },
      {
        refusal: 'an illegal move',
        game: activeGame,
        userId: 'user-1',
        move: 'e2e5',
        code: 'illegalMove',
      },
    ])('refuses $refusal', async ({ game, userId, move, code }) => {
      mockRedis.getGame.mockResolvedValue(game);

      const res = await service.makeMove(userId, 'game-1', move);

      expect(res).toMatchObject({ ok: false, error: { code } });
      expect(mockRedis.saveMove).not.toHaveBeenCalled();
    });

    it('refuses a move that comes after the time ran out and ends the game on time', async () => {
      mockRedis.getGame.mockResolvedValue({
        ...activeGame,
        lastMoveTimestamp: Date.now() - 600001,
      });

      const res = await service.makeMove('user-1', 'game-1', 'e2e4');

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'gameNotFound',
          message: 'Game game-1 ended on time before the move.',
        },
      });
      expect(mockRedis.saveMove).not.toHaveBeenCalled();
      expect(mockRedis.finishGame).toHaveBeenCalledWith(
        expect.objectContaining({ moves: [] }),
        0,
        expect.objectContaining({
          data: expect.objectContaining({
            result: 'blackWon',
            reason: 'timeout',
          }),
        }),
      );
      const names = mockServer
        .to()
        .emit.mock.calls.map(([name]: [string]) => name);
      expect(names).not.toContain('moveMade');
      expect(names).toContain('gameEnded');
    });

    it('accepts legal move, updates clock and state, broadcasts moveMade', async () => {
      mockRedis.getGame.mockResolvedValue(activeGame);
      const res = await service.makeMove('user-1', 'game-1', 'e2e4');
      expect(res.ok).toBe(true);
      expect(mockRedis.saveMove).toHaveBeenCalledWith(
        expect.objectContaining({
          moves: ['e2e4'],
          clock: expect.objectContaining({
            running: 'black',
          }),
        }),
        0,
        expect.anything(),
      );
      const [saved, , deadline] = mockRedis.saveMove.mock.calls[0];
      expect(deadline).toEqual({
        color: 'black',
        at: saved.lastMoveTimestamp + 600000,
      });
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
      expect(mockRedis.finishGame).toHaveBeenCalledWith(
        expect.any(Object),
        0,
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

  describe('events that meet another event of the same game', () => {
    function pvpGame(): ExtendedGameState {
      return {
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
    }

    function botGame(): ExtendedGameState {
      return {
        ...pvpGame(),
        black: { kind: 'bot', name: 'Stockfish bot' },
        clock: { whiteMs: 600000, running: 'white' },
      };
    }

    function emitted(event: string): [string, any][] {
      const emit = mockServer.to().emit;
      return emit.mock.calls.filter(([name]: [string]) => name === event);
    }

    it('reads the game again when another event changed it before the save', async () => {
      mockRedis.getGame
        .mockResolvedValueOnce(pvpGame())
        .mockResolvedValueOnce(pvpGame());
      mockRedis.saveMove.mockResolvedValueOnce(false);

      const res = await service.makeMove('user-1', 'game-1', 'e2e4');

      expect(res.ok).toBe(true);
      expect(mockRedis.getGame).toHaveBeenCalledTimes(2);
      // One for each user and one for the room of the game
      expect(emitted('moveMade')).toHaveLength(3);
    });

    it('announces no move that it could not store', async () => {
      mockRedis.getGame.mockImplementation(async () => pvpGame());
      mockRedis.saveMove.mockResolvedValue(false);

      await expect(
        service.makeMove('user-1', 'game-1', 'e2e4'),
      ).rejects.toThrow('changed 3 times');

      expect(emitted('moveMade')).toHaveLength(0);
    });

    it('refuses a move after the game ended in the meantime', async () => {
      mockRedis.getGame
        .mockResolvedValueOnce(pvpGame())
        .mockResolvedValueOnce(null);
      mockRedis.saveMove.mockResolvedValueOnce(false);

      const res = await service.makeMove('user-1', 'game-1', 'e2e4');

      expect(res).toEqual({
        ok: false,
        error: { code: 'gameNotFound', message: 'Game game-1 not found.' },
      });
    });

    it('stores the move that ends the game together with the end', async () => {
      const game = pvpGame();
      // The fool's mate, which black finishes with d8h4
      game.moves = ['f2f3', 'e7e5', 'g2g4'];
      game.fen =
        'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
      game.clock.running = 'black';
      mockRedis.getGame.mockResolvedValue(game);

      const res = await service.makeMove('user-2', 'game-1', 'd8h4');

      expect(res.ok).toBe(true);
      expect(mockRedis.saveMove).not.toHaveBeenCalled();
      expect(mockRedis.finishGame).toHaveBeenCalledWith(
        expect.objectContaining({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] }),
        3,
        expect.objectContaining({
          data: expect.objectContaining({
            result: 'blackWon',
            reason: 'checkmate',
          }),
        }),
      );
      const names = mockServer
        .to()
        .emit.mock.calls.map(([name]: [string]) => name);
      expect(names.lastIndexOf('moveMade')).toBeLessThan(
        names.indexOf('gameEnded'),
      );
    });

    it('refuses a second resignation, because the first one ended the game', async () => {
      mockRedis.getGame
        .mockResolvedValueOnce(pvpGame())
        .mockResolvedValueOnce(null);

      await service.resign('user-1', 'game-1');
      const second = await service.resign('user-1', 'game-1');

      expect(second.ok).toBe(false);
      expect(mockRedis.finishGame).toHaveBeenCalledTimes(1);
      expect(emitted('gameEnded')).toHaveLength(3);
    });

    it('takes the time since the last move off the clock of a player who resigns', async () => {
      const game = pvpGame();
      game.lastMoveTimestamp = Date.now() - 5000;
      mockRedis.getGame.mockResolvedValue(game);

      await service.resign('user-1', 'game-1');

      const [, payload] = emitted('gameEnded')[0];
      expect(payload.clock.whiteMs).toBeLessThanOrEqual(595000);
      expect(payload.clock.running).toBeUndefined();
    });

    it('resigns the game as it is when another event changed it first', async () => {
      const moved = pvpGame();
      moved.moves = ['e2e4'];
      mockRedis.getGame
        .mockResolvedValueOnce(pvpGame())
        .mockResolvedValueOnce(moved);
      mockRedis.finishGame.mockResolvedValueOnce(false);

      const res = await service.resign('user-1', 'game-1');

      expect(res.ok).toBe(true);
      expect(mockRedis.finishGame).toHaveBeenLastCalledWith(
        expect.objectContaining({ moves: ['e2e4'] }),
        1,
        expect.anything(),
      );
      expect(emitted('gameEnded')).toHaveLength(3);
    });

    it('drops the move of the bot when the user resigned while the engine thought', async () => {
      let answer!: (move: { success: boolean; move: string }) => void;
      mockEngine.requestMove.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      mockRedis.getGame.mockImplementation(async () => botGame());
      await service.makeMove('user-1', 'game-1', 'e2e4');
      await service.resign('user-1', 'game-1');
      mockRedis.saveMove.mockResolvedValue(false);

      answer({ success: true, move: 'e7e5' });
      await vi.waitFor(() =>
        expect(mockRedis.saveMove).toHaveBeenCalledTimes(2),
      );

      const botMoves = emitted('moveMade').filter(
        ([, payload]) => payload.move === 'e7e5',
      );
      expect(botMoves).toHaveLength(0);
    });

    it('ends the game on time only while the clock of that color still runs', async () => {
      const moved = pvpGame();
      moved.moves = ['e2e4'];
      moved.clock.running = 'black';
      mockRedis.getGame.mockResolvedValue(moved);

      await service.handleExpiredDeadline('game-1', 'white');

      expect(mockRedis.finishGame).not.toHaveBeenCalled();
    });

    it('ends nothing when a later move has replaced the deadline that was read', async () => {
      // Both users have moved since the deadline of white was read, so white has time left.
      mockRedis.getGame.mockResolvedValue(pvpGame());

      await service.handleExpiredDeadline('game-1', 'white');

      expect(mockRedis.finishGame).not.toHaveBeenCalled();
    });

    it('does nothing on a timeout of a game that has ended', async () => {
      mockRedis.getGame.mockResolvedValue(null);

      await service.handleExpiredDeadline('game-1', 'white');

      expect(mockRedis.finishGame).not.toHaveBeenCalled();
    });

    it('ends a game on time with the clock of the loser at zero', async () => {
      const game = pvpGame();
      game.lastMoveTimestamp = Date.now() - 600000;
      mockRedis.getGame.mockResolvedValue(game);

      await service.handleExpiredDeadline('game-1', 'white');

      expect(mockRedis.finishGame).toHaveBeenCalledWith(
        expect.anything(),
        0,
        expect.objectContaining({
          data: expect.objectContaining({
            result: 'blackWon',
            reason: 'timeout',
          }),
        }),
      );
      const [, payload] = emitted('gameEnded')[0];
      expect(payload.clock).toEqual({ whiteMs: 0, blackMs: 600000 });
    });
  });

  describe('the deadline of the bot', () => {
    /** A game in which the user has played e2e4 and the bot, which plays black, is to move. */
    function botToMove(): ExtendedGameState {
      return {
        gameId: 'game-1',
        variant: 'standard',
        white: { kind: 'user', userId: 'user-1', name: 'Alice' },
        black: { kind: 'bot', name: 'Stockfish bot' },
        timeControl: { initialMs: 600000 },
        startedAt: new Date(Date.now() - 60000).toISOString(),
        moves: ['e2e4'],
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        clock: { whiteMs: 590000 },
        lastMoveTimestamp: Date.now() - BOT_MOVE_DEADLINE_MS,
      };
    }

    it('lets the bot think until a deadline after the move of the user', async () => {
      mockRedis.getGame.mockResolvedValue({
        ...botToMove(),
        moves: [],
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        clock: { whiteMs: 600000, running: 'white' },
        lastMoveTimestamp: Date.now(),
      });
      mockEngine.requestMove.mockReturnValue(new Promise(() => {}));

      await service.makeMove('user-1', 'game-1', 'e2e4');

      const [saved, , deadline] = mockRedis.saveMove.mock.calls[0];
      expect(saved.clock.running).toBeUndefined();
      expect(deadline).toEqual({
        color: 'black',
        at: saved.lastMoveTimestamp + BOT_MOVE_DEADLINE_MS,
      });
    });

    it('asks the engine again for a move of the bot that has not come in time', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      mockRedis.getGame.mockResolvedValue(botToMove());
      mockEngine.requestMove.mockResolvedValue({ success: true, move: 'e7e5' });

      await service.handleExpiredDeadline('game-1', 'black');

      expect(mockRedis.claimDeadline).toHaveBeenCalledWith(
        'game-1',
        'black',
        1_000_000,
        1_000_000 + BOT_MOVE_DEADLINE_MS,
      );
      await vi.waitFor(() => expect(mockRedis.saveMove).toHaveBeenCalled());
      const [saved, storedMoveCount, deadline] =
        mockRedis.saveMove.mock.calls[0];
      expect(saved.moves).toEqual(['e2e4', 'e7e5']);
      expect(storedMoveCount).toBe(1);
      expect(deadline).toEqual({ color: 'white', at: 1_000_000 + 590000 });
    });

    it('leaves a late move of the bot to the instance that claimed it first', async () => {
      mockRedis.getGame.mockResolvedValue(botToMove());
      mockRedis.claimDeadline.mockResolvedValue(false);

      await service.handleExpiredDeadline('game-1', 'black');

      expect(mockEngine.requestMove).not.toHaveBeenCalled();
    });

    it('ignores the deadline of the bot once its move has come', async () => {
      mockRedis.getGame.mockResolvedValue({
        ...botToMove(),
        moves: ['e2e4', 'e7e5'],
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        clock: { whiteMs: 590000, running: 'white' },
        lastMoveTimestamp: Date.now(),
      });

      await service.handleExpiredDeadline('game-1', 'black');

      expect(mockRedis.claimDeadline).not.toHaveBeenCalled();
      expect(mockEngine.requestMove).not.toHaveBeenCalled();
      expect(mockRedis.finishGame).not.toHaveBeenCalled();
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
      const activeGame = {
        gameId: 'g1',
        clock: { whiteMs: 600000, blackMs: 600000 },
      } as any;
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
