import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { v7 as uuidv7 } from 'uuid';
import { RedisService, StartRefusal } from '../redis/redis.service';
import { EngineClient } from '../engine/engine.client';
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

// An event that finds its game changed by another event since it read it reads the game again, at most this often.
const MAX_ATTEMPTS = 3;

export interface ExtendedGameState extends GameState {
  lastMoveTimestamp?: number;
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

  /** The clock as it is now, with the time since the last move taken off the side whose clock runs. */
  private currentClock(game: ExtendedGameState, now: number): Clock {
    const clock = { ...game.clock };
    const running = clock.running;
    const remainingMs = running ? clock[`${running}Ms`] : undefined;
    if (running && remainingMs !== undefined) {
      const lastTimestamp =
        game.lastMoveTimestamp ?? new Date(game.startedAt).getTime();
      const elapsedMs = Math.max(0, now - lastTimestamp);
      clock[`${running}Ms`] = Math.max(0, remainingMs - elapsedMs);
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
   * Runs an attempt until it gives an answer. An attempt answers undefined when its game changed after it read it, and
   * the next attempt reads the game again, as ADR-3 requires for two events of the same game.
   */
  private async retryOnChange<T>(
    attempt: () => Promise<T | undefined>,
    operation: string,
  ): Promise<T> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const answer = await attempt();
      if (answer !== undefined) {
        return answer;
      }
    }
    throw new Error(
      `${operation} found its game changed ${MAX_ATTEMPTS} times in a row.`,
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

  /** A new game with the clock of white running, unless the bot plays white (ADR-10). */
  private newGame(white: Player, black: Player): ExtendedGameState {
    const now = new Date();
    return {
      gameId: uuidv7(),
      variant: 'standard',
      white,
      black,
      timeControl: { initialMs: 600000 },
      startedAt: now.toISOString(),
      moves: [],
      fen: STARTING_FEN,
      clock: ChessRules.createInitialClock(white, black),
      lastMoveTimestamp: now.getTime(),
    };
  }

  /**
   * User requests to join the matchmaking queue. When another user waits, the two play at once. The game is prepared
   * for the user at the head of the queue, and a queue that has changed meanwhile is read again.
   */
  async joinQueue(userId: string, name: string): Promise<OperationResponse> {
    const player: UserPlayer = { kind: 'user', userId, name };
    return this.retryOnChange(async () => {
      const waiting = await this.redisService.peekQueue();
      // Random colors (ADR-10)
      const game =
        waiting &&
        (Math.random() < 0.5
          ? this.newGame(waiting.player, player)
          : this.newGame(player, waiting.player));

      const outcome = await this.redisService.joinQueue(
        player,
        waiting && game ? { waiting, game } : undefined,
      );
      switch (outcome) {
        case 'queueChanged':
          return undefined;
        case 'alreadyInQueue':
        case 'alreadyInGame':
          return this.refusal(outcome);
        case 'matched':
          this.broadcastToUsers(
            this.userIdsOf(game!),
            'gameStarted',
            { game: this.toPublicGameState(game!) },
            game!.gameId,
          );
          return { ok: true };
        default:
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

    // Random colors (ADR-10)
    const isUserWhite = Math.random() < 0.5;
    const game = isUserWhite
      ? this.newGame(user, bot)
      : this.newGame(bot, user);

    const refused = await this.redisService.startGame(userId, game);
    if (refused) {
      return this.refusal(refused);
    }

    this.broadcastToUsers(
      [userId],
      'gameStarted',
      { game: this.toPublicGameState(game) },
      game.gameId,
    );

    // If bot plays white, its first move arrives as moveMade (AsyncAPI contract)
    if (!isUserWhite) {
      this.executeBotMoveAsync(game).catch((err) => {
        this.logger.error(`Error in bot first move: ${err.message}`);
      });
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
  ): Promise<OperationResponse | undefined> {
    const game = (await this.redisService.getGame(
      gameId,
    )) as ExtendedGameState | null;
    if (!game) {
      return {
        ok: false,
        error: { code: 'gameNotFound', message: `Game ${gameId} not found.` },
      };
    }

    // Check if user is a player in this game
    const isWhite = game.white.kind === 'user' && game.white.userId === userId;
    const isBlack = game.black.kind === 'user' && game.black.userId === userId;
    if (!isWhite && !isBlack) {
      return {
        ok: false,
        error: {
          code: 'gameNotFound',
          message: `User is not a player in game ${gameId}.`,
        },
      };
    }

    const currentTurnColor: Color =
      game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    const isUserTurn =
      (isWhite && currentTurnColor === 'white') ||
      (isBlack && currentTurnColor === 'black');
    if (!isUserTurn) {
      return {
        ok: false,
        error: { code: 'notYourTurn', message: 'It is not your turn.' },
      };
    }

    const storedMoveCount = game.moves.length;

    // Calculate elapsed time
    const now = Date.now();
    const lastTimestamp =
      game.lastMoveTimestamp ?? new Date(game.startedAt).getTime();
    const elapsedMs = Math.max(0, now - lastTimestamp);

    const { updatedClock, timedOut } = ChessRules.updateClockOnMove(
      game.clock,
      game.white,
      game.black,
      currentTurnColor,
      elapsedMs,
    );

    if (timedOut) {
      const evalRes = ChessRules.evaluateTimeout(game.fen, currentTurnColor);
      const ended = await this.endGame(
        game,
        storedMoveCount,
        evalRes.result,
        evalRes.reason,
        updatedClock,
      );
      return ended ? { ok: true } : undefined;
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
      return ended ? { ok: true } : undefined;
    }

    // The move is stored before anyone hears of it, so a move that another event has overtaken is never announced.
    if (!(await this.redisService.saveMove(game, storedMoveCount))) {
      return undefined;
    }
    this.broadcastToUsers(
      this.userIdsOf(game),
      'moveMade',
      this.moveMadeOf(game, uciMove),
      gameId,
    );

    // Check if next turn is the bot
    const nextTurnColor: Color =
      game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    const nextPlayer = nextTurnColor === 'white' ? game.white : game.black;
    if (nextPlayer.kind === 'bot') {
      this.executeBotMoveAsync(game).catch((err) => {
        this.logger.error(`Error in bot move: ${err.message}`);
      });
    }

    return { ok: true };
  }

  private moveMadeOf(game: GameState, move: string): MoveMadePayload {
    return { gameId: game.gameId, move, fen: game.fen, clock: game.clock };
  }

  /**
   * Executes a move chosen by engine-service. The game may have ended while the engine thought, for example by a
   * resignation, and then the move is dropped.
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

    const now = Date.now();
    const botColor: Color = game.fen.split(' ')[1] === 'w' ? 'white' : 'black';

    // Update clock: start opponent's clock
    game.clock.running = botColor === 'white' ? 'black' : 'white';
    game.moves.push(botMove);
    game.fen = moveResult.fen!;
    game.lastMoveTimestamp = now;

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

    if (!(await this.redisService.saveMove(game, storedMoveCount))) {
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
        `Game ${game.gameId} ended while the engine was thinking.`,
      );
    }
  }

  private logBotMoveDropped(game: GameState, move: string) {
    this.logger.log(
      `Game ${game.gameId} ended while the engine was thinking, so its move ${move} is dropped.`,
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
  ): Promise<OperationResponse | undefined> {
    const game = (await this.redisService.getGame(
      gameId,
    )) as ExtendedGameState | null;
    if (!game) {
      return {
        ok: false,
        error: { code: 'gameNotFound', message: `Game ${gameId} not found.` },
      };
    }

    const isWhite = game.white.kind === 'user' && game.white.userId === userId;
    const isBlack = game.black.kind === 'user' && game.black.userId === userId;
    if (!isWhite && !isBlack) {
      return {
        ok: false,
        error: {
          code: 'gameNotFound',
          message: `User is not in game ${gameId}.`,
        },
      };
    }

    const result: GameResult = isWhite ? 'blackWon' : 'whiteWon';
    const clock = this.currentClock(game, Date.now());
    delete clock.running;

    const ended = await this.endGame(
      game,
      game.moves.length,
      result,
      'resignation',
      clock,
    );
    return ended ? { ok: true } : undefined;
  }

  /**
   * Handles timeout triggered by background clock service. A move or an end that came first makes the timeout stale.
   */
  async handleTimeout(gameId: string, timedOutColor: Color) {
    await this.retryOnChange(async () => {
      const game = (await this.redisService.getGame(
        gameId,
      )) as ExtendedGameState | null;
      if (!game || game.clock.running !== timedOutColor) {
        return null;
      }

      const clock: Clock = { ...game.clock, [`${timedOutColor}Ms`]: 0 };
      delete clock.running;

      const evalResult = ChessRules.evaluateTimeout(game.fen, timedOutColor);
      const ended = await this.endGame(
        game,
        game.moves.length,
        evalResult.result,
        evalResult.reason,
        clock,
      );
      return ended ? null : undefined;
    }, 'A timeout');
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
      id: uuidv7(),
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
