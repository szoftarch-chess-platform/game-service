import { randomInt, randomUUIDv7 } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import {
  COMMAND_TIMEOUT_MS,
  Deadline,
  Pairing,
  RedisService,
  StartRefusal,
} from '../redis/redis.service';
import { EngineClient, MAX_MOVE_REQUEST_MS } from '../engine/engine.client';
import { ChessRules } from '../domain/chess-rules';
import {
  BotPlayer,
  Clock,
  Color,
  FinishedGame,
  GameEndReason,
  GameFinishedEvent,
  GameResult,
  GameState,
  MoveMadePayload,
  OperationResponse,
  Player,
  StateResponse,
  UserPlayer,
} from '../domain/types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Every user has 10 minutes for the whole game (ADR-10).
const INITIAL_MS = 10 * 60 * 1000;

// The bot has no clock, but its move has to be stored by this time after its turn began, which is the longest move
// request with its repeat and the longest wait for storing the move. After that any instance asks the engine again
// (GS-ADR-3).
const BOT_MOVE_DEADLINE_MS = MAX_MOVE_REQUEST_MS + COMMAND_TIMEOUT_MS;

// An event that finds the game or the queue changed by another event since it read them reads them again, at most
// this often.
const MAX_ATTEMPTS = 3;

/** The answer of an attempt that found the game or the queue changed by another event since it read them. */
const CHANGED = Symbol('changed');

export interface ExtendedGameState extends GameState {
  lastMoveTimestamp?: number;
}

/** The color of a user in a game, or undefined for a user who does not play it. */
function colorOf(game: GameState, userId: string): Color | undefined {
  return (['white', 'black'] as const).find((color) => {
    const player = game[color];
    return player.kind === 'user' && player.userId === userId;
  });
}

/** The color whose turn it is. */
function turnOf(game: GameState): Color {
  return game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

/** The time of the last move, or of the start before the first move. */
function lastMoveTime(game: ExtendedGameState): number {
  return game.lastMoveTimestamp ?? new Date(game.startedAt).getTime();
}

/** What the game waits for next, which is the clock of the user whose turn it is or the move of the bot (GS-ADR-3). */
function nextDeadline(game: ExtendedGameState): Deadline {
  const color = turnOf(game);
  const limit =
    game[color].kind === 'bot'
      ? BOT_MOVE_DEADLINE_MS
      : (game.clock[`${color}Ms`] ?? 0);
  return { color, at: lastMoveTime(game) + limit };
}

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private server: Server | null = null;

  constructor(
    private readonly redisService: RedisService,
    private readonly engineClient: EngineClient,
  ) {}

  setServer(server: Server) {
    this.server = server;
  }

  /** The time since the last move, or since the start before the first move. */
  private elapsedSinceLastMove(game: ExtendedGameState, now: number): number {
    return Math.max(0, now - lastMoveTime(game));
  }

  /** The clock as it is now, with the time since the last move taken off the side whose clock runs. */
  private currentClock(game: ExtendedGameState, now: number): Clock {
    const clock = { ...game.clock };
    const running = clock.running;
    const remainingMs = running ? clock[`${running}Ms`] : undefined;
    if (running && remainingMs !== undefined) {
      clock[`${running}Ms`] = Math.max(
        0,
        remainingMs - this.elapsedSinceLastMove(game, now),
      );
    }
    return clock;
  }

  private toPublicGameState(
    game: ExtendedGameState,
    now: number = Date.now(),
  ): GameState {
    const { lastMoveTimestamp, ...publicGame } = game;
    return { ...publicGame, clock: this.currentClock(game, now) };
  }

  private broadcastToUsers(
    userIds: string[],
    event: string,
    payload: any,
    gameId?: string,
  ) {
    if (!this.server) return;
    for (const uid of userIds) {
      this.server.to(`user:${uid}`).emit(event, payload);
    }
    if (gameId) {
      this.server.to(`game:${gameId}`).emit(event, payload);
    }
  }

  private userIdsOf(game: GameState): string[] {
    return [game.white, game.black].flatMap((player) =>
      player.kind === 'user' ? [player.userId] : [],
    );
  }

  /**
   * Runs an attempt until it gives an answer. An attempt answers `CHANGED` when another event has changed the game or
   * the queue since it read them, and the next attempt reads them again, as ADR-3 requires for events that arrive at
   * the same time.
   */
  private async retryOnChange<T>(
    attempt: () => Promise<T | typeof CHANGED>,
    operation: string,
  ): Promise<T> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const answer = await attempt();
      if (answer !== CHANGED) {
        return answer;
      }
    }
    throw new Error(
      `${operation} found what it read changed ${MAX_ATTEMPTS} times in a row.`,
    );
  }

  private refusal(code: StartRefusal): OperationResponse {
    return {
      ok: false,
      error: {
        code,
        message:
          code === 'alreadyInQueue'
            ? 'User is already in queue.'
            : 'User is already in an active game.',
      },
    };
  }

  /**
   * A new game of two players with colors drawn at random and the clock of white running, unless the bot plays white
   * (ADR-10).
   */
  private newGame(player: Player, opponent: Player): ExtendedGameState {
    const [white, black] =
      randomInt(2) === 0 ? [player, opponent] : [opponent, player];
    const now = new Date();
    return {
      gameId: randomUUIDv7(),
      variant: 'standard',
      white,
      black,
      timeControl: { initialMs: INITIAL_MS },
      startedAt: now.toISOString(),
      moves: [],
      fen: STARTING_FEN,
      clock: ChessRules.createInitialClock(white, black, INITIAL_MS),
      lastMoveTimestamp: now.getTime(),
    };
  }

  /** Every connection of the users of a new game gets `gameStarted`. */
  private announceStart(game: ExtendedGameState) {
    this.broadcastToUsers(
      this.userIdsOf(game),
      'gameStarted',
      { game: this.toPublicGameState(game) },
      game.gameId,
    );
  }

  /**
   * User requests to join the matchmaking queue. When another user waits, the two play at once. The game is prepared
   * for the user at the head of the queue, and a queue that has changed meanwhile is read again.
   */
  async joinQueue(userId: string, name: string): Promise<OperationResponse> {
    const player: UserPlayer = { kind: 'user', userId, name };
    return this.retryOnChange(async () => {
      const waiting = await this.redisService.peekQueue();
      let pairing: Pairing | undefined;
      if (waiting) {
        const game = this.newGame(waiting.player, player);
        pairing = { waiting, game, deadline: nextDeadline(game) };
      }
      const outcome = await this.redisService.joinQueue(player, pairing);
      switch (outcome) {
        case 'queueChanged':
          return CHANGED;
        case 'alreadyInQueue':
        case 'alreadyInGame':
          return this.refusal(outcome);
        case 'queued':
          return { ok: true };
        case 'matched':
          // Only a pairing can match.
          this.announceStart(pairing!.game);
          return { ok: true };
      }
    }, 'Joining the queue');
  }

  /**
   * User leaves matchmaking queue.
   */
  async leaveQueue(userId: string): Promise<OperationResponse> {
    const success = await this.redisService.leaveQueue(userId);
    if (!success) {
      return {
        ok: false,
        error: {
          code: 'notInQueue',
          message: 'User is not in queue.',
        },
      };
    }
    return { ok: true };
  }

  /**
   * User starts a game against the Stockfish bot. The check that the user is free and the new game are stored together,
   * so two starts at the same time make only one game.
   */
  async startBotGame(userId: string, name: string): Promise<OperationResponse> {
    const user: UserPlayer = { kind: 'user', userId, name };
    const bot: BotPlayer = { kind: 'bot', name: 'Stockfish bot' };
    const game = this.newGame(user, bot);

    const refused = await this.redisService.startGame(
      userId,
      game,
      nextDeadline(game),
    );
    if (refused) {
      return this.refusal(refused);
    }

    this.announceStart(game);

    // If bot plays white, its first move arrives as moveMade (AsyncAPI contract)
    if (game.white.kind === 'bot') {
      this.requestBotMove(game);
    }

    return { ok: true };
  }

  /**
   * Processes a move from a human player.
   */
  async makeMove(
    userId: string,
    gameId: string,
    uciMove: string,
  ): Promise<OperationResponse> {
    return this.retryOnChange(
      () => this.tryMove(userId, gameId, uciMove),
      'A move',
    );
  }

  private async tryMove(
    userId: string,
    gameId: string,
    uciMove: string,
  ): Promise<OperationResponse | typeof CHANGED> {
    const game = (await this.redisService.getGame(
      gameId,
    )) as ExtendedGameState | null;
    if (!game) {
      return {
        ok: false,
        error: { code: 'gameNotFound', message: `Game ${gameId} not found.` },
      };
    }

    const color = colorOf(game, userId);
    if (!color) {
      return {
        ok: false,
        error: {
          code: 'gameNotFound',
          message: `User is not a player in game ${gameId}.`,
        },
      };
    }

    if (turnOf(game) !== color) {
      return {
        ok: false,
        error: { code: 'notYourTurn', message: 'It is not your turn.' },
      };
    }

    const storedMoveCount = game.moves.length;
    const now = Date.now();

    const { updatedClock, timedOut } = ChessRules.updateClockOnMove(
      game.clock,
      game.white,
      game.black,
      color,
      this.elapsedSinceLastMove(game, now),
    );

    if (timedOut) {
      const evalRes = ChessRules.evaluateTimeout(game.fen, color);
      const ended = await this.endGame(
        game,
        storedMoveCount,
        evalRes.result,
        evalRes.reason,
        updatedClock,
      );
      if (!ended) {
        return CHANGED;
      }
      // The game ended on time before the move, so the move is not made (ADR-10).
      return {
        ok: false,
        error: {
          code: 'gameNotFound',
          message: `Game ${gameId} ended on time before the move.`,
        },
      };
    }

    // Validate and apply move with chess.js
    const moveResult = ChessRules.applyMove(game.fen, uciMove, game.moves);
    if (!moveResult.valid) {
      return {
        ok: false,
        error: {
          code: moveResult.errorCode ?? 'illegalMove',
          message: moveResult.errorMessage ?? `${uciMove} is not a legal move.`,
        },
      };
    }

    // Apply move updates
    game.moves.push(uciMove);
    game.fen = moveResult.fen!;
    game.clock = updatedClock;
    game.lastMoveTimestamp = now;

    if (moveResult.isGameOver) {
      // Game over by checkmate, stalemate, repetition, 50-move, or insufficient material
      delete game.clock.running;
      const ended = await this.endGame(
        game,
        storedMoveCount,
        moveResult.result!,
        moveResult.reason!,
        game.clock,
        this.moveMadeOf(game, uciMove),
      );
      return ended ? { ok: true } : CHANGED;
    }

    // The move is stored before anyone hears of it, so a move that another event has overtaken is never announced.
    if (
      !(await this.redisService.saveMove(
        game,
        storedMoveCount,
        nextDeadline(game),
      ))
    ) {
      return CHANGED;
    }
    this.broadcastToUsers(
      this.userIdsOf(game),
      'moveMade',
      this.moveMadeOf(game, uciMove),
      gameId,
    );

    // In a game against the bot the bot moves next.
    if (game[turnOf(game)].kind === 'bot') {
      this.requestBotMove(game);
    }

    return { ok: true };
  }

  private moveMadeOf(game: GameState, move: string): MoveMadePayload {
    return { gameId: game.gameId, move, fen: game.fen, clock: game.clock };
  }

  /** Asks the engine for the move of the bot without making the event that led to it wait. */
  private requestBotMove(game: ExtendedGameState) {
    this.executeBotMoveAsync(game).catch((err) => {
      this.logger.error(
        `The move of the bot in game ${game.gameId} failed: ${err.message}`,
      );
    });
  }

  /**
   * Executes a move chosen by engine-service. The game may have ended or changed while the engine thought, for example
   * by a resignation or by the move that another instance asked for after the deadline of the bot, and then the move
   * is dropped.
   */
  private async executeBotMoveAsync(game: ExtendedGameState) {
    const storedMoveCount = game.moves.length;
    const botResponse = await this.engineClient.requestMove(
      game.fen,
      game.variant,
    );

    if (!botResponse.success || !botResponse.move) {
      // If engine failed both attempts, abort the game with engineFailure (ADR-6, ADR-10)
      this.logger.error(
        `Engine failed to provide a move for game ${game.gameId}. Aborting.`,
      );
      await this.abortForEngine(game, storedMoveCount);
      return;
    }

    const botMove = botResponse.move;
    const moveResult = ChessRules.applyMove(game.fen, botMove, game.moves);
    if (!moveResult.valid) {
      this.logger.error(`Engine returned illegal move ${botMove}. Aborting.`);
      await this.abortForEngine(game, storedMoveCount);
      return;
    }

    game.moves.push(botMove);
    game.fen = moveResult.fen!;
    // The clock of the user runs again after the move of the bot.
    game.clock.running = turnOf(game);
    game.lastMoveTimestamp = Date.now();

    if (moveResult.isGameOver) {
      delete game.clock.running;
      const ended = await this.endGame(
        game,
        storedMoveCount,
        moveResult.result!,
        moveResult.reason!,
        game.clock,
        this.moveMadeOf(game, botMove),
      );
      if (!ended) {
        this.logBotMoveDropped(game, botMove);
      }
      return;
    }

    if (
      !(await this.redisService.saveMove(
        game,
        storedMoveCount,
        nextDeadline(game),
      ))
    ) {
      this.logBotMoveDropped(game, botMove);
      return;
    }
    this.broadcastToUsers(
      this.userIdsOf(game),
      'moveMade',
      this.moveMadeOf(game, botMove),
      game.gameId,
    );
  }

  private async abortForEngine(
    game: ExtendedGameState,
    storedMoveCount: number,
  ) {
    const clock = { ...game.clock };
    delete clock.running;
    const ended = await this.endGame(
      game,
      storedMoveCount,
      'aborted',
      'engineFailure',
      clock,
    );
    if (!ended) {
      this.logger.log(
        `Game ${game.gameId} ended or changed while the engine was thinking.`,
      );
    }
  }

  private logBotMoveDropped(game: GameState, move: string) {
    this.logger.log(
      `Game ${game.gameId} ended or changed while the engine was thinking, so its move ${move} is dropped.`,
    );
  }

  /**
   * User resigns current game.
   */
  async resign(userId: string, gameId: string): Promise<OperationResponse> {
    return this.retryOnChange(
      () => this.tryResign(userId, gameId),
      'A resignation',
    );
  }

  private async tryResign(
    userId: string,
    gameId: string,
  ): Promise<OperationResponse | typeof CHANGED> {
    const game = (await this.redisService.getGame(
      gameId,
    )) as ExtendedGameState | null;
    if (!game) {
      return {
        ok: false,
        error: { code: 'gameNotFound', message: `Game ${gameId} not found.` },
      };
    }

    const color = colorOf(game, userId);
    if (!color) {
      return {
        ok: false,
        error: {
          code: 'gameNotFound',
          message: `User is not in game ${gameId}.`,
        },
      };
    }

    const result: GameResult = color === 'white' ? 'blackWon' : 'whiteWon';
    const clock = this.currentClock(game, Date.now());
    delete clock.running;

    const ended = await this.endGame(
      game,
      game.moves.length,
      result,
      'resignation',
      clock,
    );
    return ended ? { ok: true } : CHANGED;
  }

  /**
   * Handles a deadline of a game that has passed, unless a move or an end came first. A user whose clock has run out
   * loses on time, and a move of the bot that has not come in time is asked for again (GS-ADR-3).
   */
  async handleExpiredDeadline(gameId: string, color: Color) {
    await this.retryOnChange(async () => {
      const game = (await this.redisService.getGame(
        gameId,
      )) as ExtendedGameState | null;
      if (!game || turnOf(game) !== color) {
        return;
      }
      if (game[color].kind === 'bot') {
        return this.askEngineAgain(game);
      }
      return this.endOnTime(game, color);
    }, 'A deadline');
  }

  /**
   * Ends a game on time if the clock of the color has run out by now. The game decides it, so a deadline that a later
   * move has replaced since it was read ends nothing.
   */
  private async endOnTime(
    game: ExtendedGameState,
    color: Color,
  ): Promise<void | typeof CHANGED> {
    const clock: Clock = this.currentClock(game, Date.now());
    if ((clock[`${color}Ms`] ?? 0) > 0) {
      return;
    }
    delete clock.running;

    const evalResult = ChessRules.evaluateTimeout(game.fen, color);
    const ended = await this.endGame(
      game,
      game.moves.length,
      evalResult.result,
      evalResult.reason,
      clock,
    );
    if (!ended) {
      return CHANGED;
    }
    this.logger.log(`Game ${game.gameId} ended on the time of ${color}.`);
  }

  /**
   * Asks the engine again for a move of the bot that has not been stored in time, for example because the instance
   * that asked for it has stopped. The claim of the deadline lets one instance ask, and it gives the move a new
   * deadline, after which another instance asks if this one fails too.
   */
  private async askEngineAgain(game: ExtendedGameState) {
    const now = Date.now();
    const claimed = await this.redisService.claimDeadline(
      game.gameId,
      turnOf(game),
      now,
      now + BOT_MOVE_DEADLINE_MS,
    );
    if (!claimed) {
      return;
    }
    this.logger.warn(
      `The move of the bot in game ${game.gameId} has not come in time, so the engine is asked again.`,
    );
    this.requestBotMove(game);
  }

  /**
   * Ends a game unless another event has changed or ended it since it was read, and returns whether it did. The end and
   * the event `game.finished.v1` are stored together (ADR-6). Then the players get the move that ended the game, if a
   * move did, and `gameEnded`.
   */
  private async endGame(
    game: ExtendedGameState,
    storedMoveCount: number,
    result: GameResult,
    reason: GameEndReason,
    clock: Clock,
    lastMove?: MoveMadePayload,
  ): Promise<boolean> {
    const endedAt = new Date().toISOString();

    const finishedData: FinishedGame = {
      gameId: game.gameId,
      variant: game.variant,
      white: game.white,
      black: game.black,
      result,
      reason,
      moves: game.moves,
      timeControl: game.timeControl,
      startedAt: game.startedAt,
      endedAt,
    };

    const outboxEvent: GameFinishedEvent = {
      id: randomUUIDv7(),
      type: 'game.finished.v1',
      source: 'game-service',
      time: endedAt,
      data: finishedData,
    };

    if (
      !(await this.redisService.finishGame(game, storedMoveCount, outboxEvent))
    ) {
      return false;
    }

    const userIds = this.userIdsOf(game);
    if (lastMove) {
      this.broadcastToUsers(userIds, 'moveMade', lastMove, game.gameId);
    }
    this.broadcastToUsers(
      userIds,
      'gameEnded',
      {
        gameId: game.gameId,
        result,
        reason,
        clock,
      },
      game.gameId,
    );
    return true;
  }

  /**
   * Returns current user state for getState operation.
   */
  async getState(userId: string): Promise<StateResponse> {
    const status = await this.redisService.getUserStatus(userId);
    if (status.status === 'queue') {
      return { ok: true, queued: true };
    }
    if (status.status === 'game' && status.gameId) {
      const game = (await this.redisService.getGame(
        status.gameId,
      )) as ExtendedGameState | null;
      if (game) {
        return { ok: true, queued: false, game: this.toPublicGameState(game) };
      }
    }
    return { ok: true, queued: false };
  }
}
