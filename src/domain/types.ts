export type Color = 'white' | 'black';

export type Variant = 'standard';

export type GameResult = 'whiteWon' | 'blackWon' | 'draw' | 'aborted';

export type GameEndReason =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'threefoldRepetition'
  | 'fiftyMoveRule'
  | 'insufficientMaterial'
  | 'engineFailure';

export interface UserPlayer {
  kind: 'user';
  userId: string;
  name: string;
}

export interface BotPlayer {
  kind: 'bot';
  name: 'Stockfish bot';
}

export type Player = UserPlayer | BotPlayer;

export interface TimeControl {
  initialMs: number;
}

export interface Clock {
  whiteMs?: number;
  blackMs?: number;
  running?: Color;
}

export interface GameState {
  gameId: string;
  variant: Variant;
  white: Player;
  black: Player;
  timeControl: TimeControl;
  startedAt: string;
  moves: string[];
  fen: string;
  clock: Clock;
}

export type ErrorCode =
  | 'invalidPayload'
  | 'alreadyInQueue'
  | 'alreadyInGame'
  | 'notInQueue'
  | 'gameNotFound'
  | 'notYourTurn'
  | 'illegalMove'
  | 'internalError';

export interface AcceptedResponse {
  ok: true;
}

export interface RejectedResponse {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type OperationResponse = AcceptedResponse | RejectedResponse;

export interface StateResponse {
  ok: true;
  queued: boolean;
  game?: GameState;
}

export interface GameStartedPayload {
  game: GameState;
}

export interface MoveMadePayload {
  gameId: string;
  move: string;
  fen: string;
  clock: Clock;
}

export interface GameEndedPayload {
  gameId: string;
  result: GameResult;
  reason: GameEndReason;
  clock: Clock;
}

export interface FinishedGame {
  gameId: string;
  variant: Variant;
  white: Player;
  black: Player;
  result: GameResult;
  reason: GameEndReason;
  moves: string[];
  timeControl: TimeControl;
  startedAt: string;
  endedAt: string;
}

export interface GameFinishedEvent {
  id: string;
  type: 'game.finished.v1';
  source: 'game-service';
  time: string;
  data: FinishedGame;
}
