import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { ChessRules } from './chess-rules';
import { UserPlayer, BotPlayer } from './types';

describe('ChessRules', () => {
  const startingFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('should accept a legal opening move', () => {
    const result = ChessRules.applyMove(startingFen, 'e2e4');
    expect(result.valid).toBe(true);
    expect(result.fen).toBeDefined();
    expect(result.isGameOver).toBe(false);
  });

  it('should reject an illegal move', () => {
    const result = ChessRules.applyMove(startingFen, 'e2e5');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('illegalMove');
  });

  it('should reject a malformed move string', () => {
    const result = ChessRules.applyMove(startingFen, 'bad');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('illegalMove');
  });

  it('should handle castling correctly', () => {
    // Setup position where white can castle kingside
    const fen = 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const result = ChessRules.applyMove(fen, 'e1g1');
    expect(result.valid).toBe(true);
    expect(result.fen).toContain('RNBQ1RK1');
  });

  it('should handle pawn promotion to queen and knight', () => {
    const promoFen = '8/4P3/8/8/8/8/8/k6K w - - 0 1';
    const queenPromo = ChessRules.applyMove(promoFen, 'e7e8q');
    expect(queenPromo.valid).toBe(true);
    expect(queenPromo.fen).toContain('4Q3');

    const knightPromo = ChessRules.applyMove(promoFen, 'e7e8n');
    expect(knightPromo.valid).toBe(true);
    expect(knightPromo.fen).toContain('4N3');
  });

  it('should handle en passant capture', () => {
    // 1. e4 e6 2. e5 d5 3. exd6 (en passant)
    const moves = ['e2e4', 'e7e6', 'e4e5', 'd7d5'];
    let currentFen = startingFen;
    for (const m of moves) {
      const res = ChessRules.applyMove(currentFen, m);
      expect(res.valid).toBe(true);
      currentFen = res.fen!;
    }

    const enPassantRes = ChessRules.applyMove(currentFen, 'e5d6');
    expect(enPassantRes.valid).toBe(true);
    expect(enPassantRes.capturedPiece).toBe('p');
  });

  it('should detect checkmate (Scholar’s mate)', () => {
    let fen = startingFen;
    const moves = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'];

    let lastResult;
    for (const m of moves) {
      lastResult = ChessRules.applyMove(fen, m);
      expect(lastResult.valid).toBe(true);
      fen = lastResult.fen!;
    }

    expect(lastResult?.isGameOver).toBe(true);
    expect(lastResult?.result).toBe('whiteWon');
    expect(lastResult?.reason).toBe('checkmate');
  });

  it('should detect stalemate', () => {
    const stalemateFen = 'k7/8/1Q6/8/8/8/8/7K b - - 0 1';
    const chess = new Chess(stalemateFen);
    const gameOver = ChessRules.checkGameOver(chess);
    expect(gameOver.isGameOver).toBe(true);
    expect(gameOver.result).toBe('draw');
    expect(gameOver.reason).toBe('stalemate');
  });

  it('should detect threefold repetition with move history', () => {
    // 1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8
    const moves = [
      'g1f3', 'g8f6', 'f3g1', 'f6g8',
      'g1f3', 'g8f6', 'f3g1', 'f6g8',
    ];

    let currentFen = startingFen;
    const history: string[] = [];
    let lastResult;

    for (const m of moves) {
      lastResult = ChessRules.applyMove(currentFen, m, history);
      expect(lastResult.valid).toBe(true);
      history.push(m);
      currentFen = lastResult.fen!;
    }

    expect(lastResult?.isGameOver).toBe(true);
    expect(lastResult?.result).toBe('draw');
    expect(lastResult?.reason).toBe('threefoldRepetition');
  });

  it('should detect 50-move rule draw', () => {
    // White and Black both have a rook and king (sufficient mating material),
    // halfmove clock is 99 (49.5 full moves without pawn move or capture)
    const fiftyMoveFen = '4k3/8/8/8/8/8/8/R3K2r w - - 99 50';
    const chess = new Chess(fiftyMoveFen);
    // Non-capture king move e1d2 makes halfmove clock 100
    chess.move({ from: 'e1', to: 'd2' });
    const gameOver = ChessRules.checkGameOver(chess);
    expect(gameOver.isGameOver).toBe(true);
    expect(gameOver.result).toBe('draw');
    expect(gameOver.reason).toBe('fiftyMoveRule');
  });

  it('should evaluate timeout correctly when opponent has sufficient material', () => {
    // White times out, black has rook and king
    const fen = 'k7/8/8/8/8/8/8/r6K w - - 0 1';
    const evalResult = ChessRules.evaluateTimeout(fen, 'white');
    expect(evalResult.result).toBe('blackWon');
    expect(evalResult.reason).toBe('timeout');

    // Black times out, white has queen and king
    const fen2 = 'k7/8/8/8/8/8/8/Q6K b - - 0 1';
    const evalResult2 = ChessRules.evaluateTimeout(fen2, 'black');
    expect(evalResult2.result).toBe('whiteWon');
    expect(evalResult2.reason).toBe('timeout');
  });

  it('should evaluate timeout as draw when opponent has insufficient material (Article 6.9)', () => {
    // White times out, black has only lone king
    const fen = 'k7/8/8/8/8/8/8/7K w - - 0 1';
    const evalResult = ChessRules.evaluateTimeout(fen, 'white');
    expect(evalResult.result).toBe('draw');
    expect(evalResult.reason).toBe('timeout');

    // Black times out, white has king + 1 bishop
    const fenBishop = 'k7/8/8/8/8/8/8/B6K b - - 0 1';
    const evalResultBishop = ChessRules.evaluateTimeout(fenBishop, 'black');
    expect(evalResultBishop.result).toBe('draw');
    expect(evalResultBishop.reason).toBe('timeout');

    // White times out, black has king + 1 knight
    const fenKnight = 'k7/8/8/8/8/8/8/n6K w - - 0 1';
    const evalResultKnight = ChessRules.evaluateTimeout(fenKnight, 'white');
    expect(evalResultKnight.result).toBe('draw');
    expect(evalResultKnight.reason).toBe('timeout');
  });

  describe('Clock handling', () => {
    const userWhite: UserPlayer = { kind: 'user', userId: 'user-1', name: 'Alice' };
    const userBlack: UserPlayer = { kind: 'user', userId: 'user-2', name: 'Bob' };
    const bot: BotPlayer = { kind: 'bot', name: 'Stockfish bot' };

    it('creates initial clock for human vs human game', () => {
      const clock = ChessRules.createInitialClock(userWhite, userBlack, 600000);
      expect(clock.whiteMs).toBe(600000);
      expect(clock.blackMs).toBe(600000);
      expect(clock.running).toBe('white');
    });

    it('creates initial clock for bot (white) vs human (black)', () => {
      const clock = ChessRules.createInitialClock(bot, userBlack, 600000);
      expect(clock.whiteMs).toBeUndefined();
      expect(clock.blackMs).toBe(600000);
      expect(clock.running).toBeUndefined(); // Bot thinks, clock not running
    });

    it('updates clock after white moves against bot', () => {
      const initialClock = ChessRules.createInitialClock(userWhite, bot, 600000);
      const { updatedClock, timedOut } = ChessRules.updateClockOnMove(
        initialClock,
        userWhite,
        bot,
        'white',
        5000,
      );
      expect(timedOut).toBe(false);
      expect(updatedClock.whiteMs).toBe(595000);
      expect(updatedClock.running).toBeUndefined(); // Next turn is bot, clock stopped
    });

    it('detects timeout on move if time exceeded and unsets running', () => {
      const initialClock = ChessRules.createInitialClock(userWhite, userBlack, 600000);
      const { updatedClock, timedOut } = ChessRules.updateClockOnMove(
        initialClock,
        userWhite,
        userBlack,
        'white',
        650000,
      );
      expect(timedOut).toBe(true);
      expect(updatedClock.whiteMs).toBe(0);
      expect(updatedClock.running).toBeUndefined();
    });
  });
});
