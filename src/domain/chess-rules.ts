import { Chess } from 'chess.js';
import { Color, GameEndReason, GameResult, Player, Clock } from './types';

export interface MoveExecutionResult {
  valid: boolean;
  errorCode?: 'illegalMove';
  errorMessage?: string;
  fen?: string;
  isGameOver?: boolean;
  result?: GameResult;
  reason?: GameEndReason;
  capturedPiece?: string;
}

export class ChessRules {
  /**
   * Validates and applies a move in UCI format (e.g. "e2e4", "e7e8q").
   * Optionally accepts past move history to accurately detect threefold repetition (ADR-9, ADR-10).
   */
  static applyMove(
    fen: string,
    uciMove: string,
    moveHistory?: string[],
  ): MoveExecutionResult {
    let chess: Chess;

    if (moveHistory && moveHistory.length > 0) {
      chess = new Chess();
      for (const m of moveHistory) {
        const from = m.slice(0, 2);
        const to = m.slice(2, 4);
        const promotion = m.slice(4) || undefined;
        chess.move({
          from,
          to,
          promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined,
        });
      }
    } else {
      chess = new Chess(fen);
    }

    if (uciMove.length < 4 || uciMove.length > 5) {
      return {
        valid: false,
        errorCode: 'illegalMove',
        errorMessage: `${uciMove} is not a valid UCI move format.`,
      };
    }

    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.slice(4) || undefined;

    try {
      const moveResult = chess.move({
        from,
        to,
        promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined,
      });

      if (!moveResult) {
        return {
          valid: false,
          errorCode: 'illegalMove',
          errorMessage: `${uciMove} is not a legal move.`,
        };
      }

      const newFen = chess.fen();
      const gameOverInfo = this.checkGameOver(chess);

      return {
        valid: true,
        fen: newFen,
        isGameOver: gameOverInfo.isGameOver,
        result: gameOverInfo.result,
        reason: gameOverInfo.reason,
        capturedPiece: moveResult.captured,
      };
    } catch {
      return {
        valid: false,
        errorCode: 'illegalMove',
        errorMessage: `${uciMove} is not a legal move.`,
      };
    }
  }

  /**
   * Checks whether the game has ended by standard chess rules (ADR-9, ADR-10).
   */
  static checkGameOver(chess: Chess): {
    isGameOver: boolean;
    result?: GameResult;
    reason?: GameEndReason;
  } {
    if (chess.isCheckmate()) {
      // The side to move is checkmated, so the previous side won
      const winner: GameResult = chess.turn() === 'w' ? 'blackWon' : 'whiteWon';
      return {
        isGameOver: true,
        result: winner,
        reason: 'checkmate',
      };
    }

    if (chess.isStalemate()) {
      return {
        isGameOver: true,
        result: 'draw',
        reason: 'stalemate',
      };
    }

    if (chess.isThreefoldRepetition()) {
      return {
        isGameOver: true,
        result: 'draw',
        reason: 'threefoldRepetition',
      };
    }

    if (chess.isInsufficientMaterial()) {
      return {
        isGameOver: true,
        result: 'draw',
        reason: 'insufficientMaterial',
      };
    }

    // chess.js isDraw() covers 50-move rule when stalemate and insufficient material are false
    if (chess.isDraw()) {
      return {
        isGameOver: true,
        result: 'draw',
        reason: 'fiftyMoveRule',
      };
    }

    return { isGameOver: false };
  }

  /**
   * Article 6.9 of FIDE / ADR-10:
   * When a player runs out of time, they lose, unless the opponent has only the king,
   * or the king and a single bishop or knight. In that case, it is a draw.
   */
  static evaluateTimeout(
    fen: string,
    timedOutColor: Color,
  ): { result: GameResult; reason: GameEndReason } {
    const chess = new Chess(fen);
    const opponentColor = timedOutColor === 'white' ? 'black' : 'white';
    const opponentColorChar = opponentColor === 'white' ? 'w' : 'b';

    const opponentPieces: string[] = [];
    const board = chess.board();

    for (const row of board) {
      for (const square of row) {
        if (square && square.color === opponentColorChar) {
          opponentPieces.push(square.type);
        }
      }
    }

    // Lone king (1 piece) or king + 1 bishop or knight (2 pieces)
    const hasInsufficientMaterialToMate =
      opponentPieces.length === 1 ||
      (opponentPieces.length === 2 &&
        (opponentPieces.includes('b') || opponentPieces.includes('n')));

    if (hasInsufficientMaterialToMate) {
      return {
        result: 'draw',
        reason: 'timeout',
      };
    }

    return {
      result: timedOutColor === 'white' ? 'blackWon' : 'whiteWon',
      reason: 'timeout',
    };
  }

  /**
   * Computes the updated clock after a move (ADR-10).
   */
  static updateClockOnMove(
    currentClock: Clock,
    whitePlayer: Player,
    blackPlayer: Player,
    movedColor: Color,
    elapsedMs: number,
  ): { updatedClock: Clock; timedOut: boolean } {
    const clock: Clock = { ...currentClock };

    if (movedColor === 'white' && whitePlayer.kind === 'user') {
      const remaining = Math.max(0, (clock.whiteMs ?? 600000) - elapsedMs);
      clock.whiteMs = remaining;
      if (remaining <= 0) {
        delete clock.running;
        return { updatedClock: clock, timedOut: true };
      }
    } else if (movedColor === 'black' && blackPlayer.kind === 'user') {
      const remaining = Math.max(0, (clock.blackMs ?? 600000) - elapsedMs);
      clock.blackMs = remaining;
      if (remaining <= 0) {
        delete clock.running;
        return { updatedClock: clock, timedOut: true };
      }
    }

    const nextColor: Color = movedColor === 'white' ? 'black' : 'white';
    const nextPlayer = nextColor === 'white' ? whitePlayer : blackPlayer;

    if (nextPlayer.kind === 'bot') {
      // The bot has no clock, and running is left out while the bot thinks (ADR-10)
      delete clock.running;
    } else {
      clock.running = nextColor;
    }

    return { updatedClock: clock, timedOut: false };
  }

  /**
   * Returns the initial clock state for a newly started game.
   */
  static createInitialClock(
    white: Player,
    black: Player,
    initialMs = 600000,
  ): Clock {
    const clock: Clock = {};
    if (white.kind === 'user') {
      clock.whiteMs = initialMs;
      clock.running = 'white';
    }
    if (black.kind === 'user') {
      clock.blackMs = initialMs;
    }
    // If white is bot, white has no clock and running is omitted while bot thinks
    if (white.kind === 'bot') {
      delete clock.running;
    }
    return clock;
  }
}
