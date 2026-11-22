import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { v7 as uuidv7 } from 'uuid';
import { RedisService } from '../redis/redis.service';
import { EngineClient } from '../engine/engine.client';
import { ChessRules } from '../domain/chess-rules';
import {
  BotPlayer,
  Color,
  FinishedGame,
  GameEndReason,
  GameFinishedEvent,
  GameResult,
  GameState,
  OperationResponse,
  Player,
  StateResponse,
  UserPlayer,
} from '../domain/types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

  private toPublicGameState(game: ExtendedGameState): GameState {
    const { lastMoveTimestamp, ...publicGame } = game;
    return publicGame;
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

  /**
   * User requests to join the matchmaking queue.
   */
  async joinQueue(userId: string, name: string): Promise<OperationResponse> {
    const player: UserPlayer = { kind: 'user', userId, name };
    const result = await this.redisService.joinQueue(player);

    if (result.error) {
      return {
        ok: false,
        error: {
          code: result.error,
          message:
            result.error === 'alreadyInQueue'
              ? 'User is already in queue.'
              : 'User is already in an active game.',
        },
      };
    }

    if (result.matched) {
      const [p1, p2] = result.matched;
      await this.initiatePvPGame(p1, p2);
    }

    return { ok: true };
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
   * User starts a game against the Stockfish bot.
   */
  async startBotGame(userId: string, name: string): Promise<OperationResponse> {
    const status = await this.redisService.getUserStatus(userId);
    if (status.status === 'queue') {
      return {
        ok: false,
        error: {
          code: 'alreadyInQueue',
          message: 'User is currently in queue.',
        },
      };
    }
    if (status.status === 'game') {
      return {
        ok: false,
        error: {
          code: 'alreadyInGame',
          message: 'User is already in an active game.',
        },
      };
    }

    const user: UserPlayer = { kind: 'user', userId, name };
    const bot: BotPlayer = { kind: 'bot', name: 'Stockfish bot' };

    // Random colors (ADR-10)
    const isUserWhite = Math.random() < 0.5;
    const white: Player = isUserWhite ? user : bot;
    const black: Player = isUserWhite ? bot : user;

    const gameId = uuidv7();
    const now = new Date();
    const startedAt = now.toISOString();

    const game: ExtendedGameState = {
      gameId,
      variant: 'standard',
      white,
      black,
      timeControl: { initialMs: 600000 },
      startedAt,
      moves: [],
      fen: STARTING_FEN,
      clock: ChessRules.createInitialClock(white, black),
      lastMoveTimestamp: now.getTime(),
    };

    await this.redisService.createGame(game);

    this.broadcastToUsers(
      [userId],
      'gameStarted',
      { game: this.toPublicGameState(game) },
      gameId,
    );

    // If bot plays white, its first move arrives as moveMade (AsyncAPI contract)
    if (white.kind === 'bot') {
      this.executeBotMoveAsync(game).catch((err) => {
        this.logger.error(`Error in bot first move: ${err.message}`);
      });
    }

    return { ok: true };
  }

  /**
   * Pairs two human players and initializes the game.
   */
  private async initiatePvPGame(p1: UserPlayer, p2: UserPlayer) {
    const isP1White = Math.random() < 0.5;
    const white = isP1White ? p1 : p2;
    const black = isP1White ? p2 : p1;

    const gameId = uuidv7();
    const now = new Date();
    const startedAt = now.toISOString();

    const game: ExtendedGameState = {
      gameId,
      variant: 'standard',
      white,
      black,
      timeControl: { initialMs: 600000 },
      startedAt,
      moves: [],
      fen: STARTING_FEN,
      clock: ChessRules.createInitialClock(white, black),
      lastMoveTimestamp: now.getTime(),
    };

    await this.redisService.createGame(game);

    this.broadcastToUsers(
      [p1.userId, p2.userId],
      'gameStarted',
      { game: this.toPublicGameState(game) },
      gameId,
    );
  }

  /**
   * Processes a move from a human player.
   */
  async makeMove(
    userId: string,
    gameId: string,
    uciMove: string,
  ): Promise<OperationResponse> {
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

    const playerUserIds: string[] = [];
    if (game.white.kind === 'user') playerUserIds.push(game.white.userId);
    if (game.black.kind === 'user') playerUserIds.push(game.black.userId);

    if (timedOut) {
      const evalRes = ChessRules.evaluateTimeout(game.fen, currentTurnColor);
      await this.finalizeGame(
        game,
        evalRes.result,
        evalRes.reason,
        updatedClock,
      );
      return { ok: true };
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
      delete game.clock.running;
    }

    // Broadcast moveMade to both players and spectators
    this.broadcastToUsers(
      playerUserIds,
      'moveMade',
      {
        gameId,
        move: uciMove,
        fen: game.fen,
        clock: game.clock,
      },
      gameId,
    );

    if (moveResult.isGameOver) {
      // Game over by checkmate, stalemate, repetition, 50-move, or insufficient material
      await this.finalizeGame(
        game,
        moveResult.result!,
        moveResult.reason!,
        game.clock,
      );
    } else {
      await this.redisService.saveGameState(game, false);

      // Check if next turn is the bot
      const nextTurnColor: Color =
        game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
      const nextPlayer = nextTurnColor === 'white' ? game.white : game.black;
      if (nextPlayer.kind === 'bot') {
        this.executeBotMoveAsync(game).catch((err) => {
          this.logger.error(`Error in bot move: ${err.message}`);
        });
      }
    }

    return { ok: true };
  }

  /**
   * Executes a move chosen by engine-service.
   */
  private async executeBotMoveAsync(game: ExtendedGameState) {
    const botResponse = await this.engineClient.requestMove(
      game.fen,
      game.variant,
    );

    if (!botResponse.success || !botResponse.move) {
      // If engine failed both attempts, abort the game with engineFailure (ADR-6, ADR-10)
      this.logger.error(
        `Engine failed to provide a move for game ${game.gameId}. Aborting.`,
      );
      delete game.clock.running;
      await this.finalizeGame(game, 'aborted', 'engineFailure', game.clock);
      return;
    }

    const botMove = botResponse.move;
    const moveResult = ChessRules.applyMove(game.fen, botMove, game.moves);
    if (!moveResult.valid) {
      this.logger.error(`Engine returned illegal move ${botMove}. Aborting.`);
      delete game.clock.running;
      await this.finalizeGame(game, 'aborted', 'engineFailure', game.clock);
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
    }

    const userIds: string[] = [];
    if (game.white.kind === 'user') userIds.push(game.white.userId);
    if (game.black.kind === 'user') userIds.push(game.black.userId);

    this.broadcastToUsers(
      userIds,
      'moveMade',
      {
        gameId: game.gameId,
        move: botMove,
        fen: game.fen,
        clock: game.clock,
      },
      game.gameId,
    );

    if (moveResult.isGameOver) {
      await this.finalizeGame(
        game,
        moveResult.result!,
        moveResult.reason!,
        game.clock,
      );
    } else {
      await this.redisService.saveGameState(game, false);
    }
  }

  /**
   * User resigns current game.
   */
  async resign(userId: string, gameId: string): Promise<OperationResponse> {
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
    delete game.clock.running;

    await this.finalizeGame(game, result, 'resignation', game.clock);
    return { ok: true };
  }

  /**
   * Handles timeout triggered by background clock service.
   */
  async handleTimeout(gameId: string, timedOutColor: Color) {
    const game = (await this.redisService.getGame(
      gameId,
    )) as ExtendedGameState | null;
    if (!game) return;

    if (timedOutColor === 'white') {
      game.clock.whiteMs = 0;
    } else {
      game.clock.blackMs = 0;
    }
    delete game.clock.running;

    const evalResult = ChessRules.evaluateTimeout(game.fen, timedOutColor);
    await this.finalizeGame(
      game,
      evalResult.result,
      evalResult.reason,
      game.clock,
    );
  }

  /**
   * Finalizes game: broadcasts gameEnded, saves state and enqueues game.finished.v1 event to outbox.
   */
  private async finalizeGame(
    game: ExtendedGameState,
    result: GameResult,
    reason: GameEndReason,
    clock: GameState['clock'],
  ) {
    const userIds: string[] = [];
    if (game.white.kind === 'user') userIds.push(game.white.userId);
    if (game.black.kind === 'user') userIds.push(game.black.userId);

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

    await this.redisService.saveGameState(game, true, outboxEvent);

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
