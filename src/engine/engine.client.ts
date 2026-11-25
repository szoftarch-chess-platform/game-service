import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

// The engine-service answers within the time limit of its contract, and the game-service waits five seconds longer
// (ADR-6).
const REQUEST_TIMEOUT_MS = 15_000;

// A failed request is repeated once (ADR-6).
const ATTEMPTS = 2;

/** The longest time that a move request with its repeat can take. */
export const MAX_MOVE_REQUEST_MS = ATTEMPTS * REQUEST_TIMEOUT_MS;

export interface EngineMoveResponse {
  success: boolean;
  move?: string;
  error?: string;
}

@Injectable()
export class EngineClient {
  private readonly logger = new Logger(EngineClient.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * Calls engine-service POST /moves to get a move for the given FEN. A request that takes longer than the time limit
   * fails, and a failed request is repeated once, unless the engine-service refused the position (ADR-6).
   */
  async requestMove(
    fen: string,
    variant = 'standard',
  ): Promise<EngineMoveResponse> {
    const url = `${this.config.engineUrl}/moves`;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        // The time limit covers the body of the answer too.
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fen, variant }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const data = (await response.json()) as { move: string };
          return { success: true, move: data.move };
        }

        const status = response.status;
        this.logger.warn(
          `Engine service returned HTTP ${status} on attempt ${attempt}`,
        );

        // If client error (400 or 422), do not retry (ADR-6 / OpenAPI contract notes repeating gets same answer)
        if (status === 400 || status === 422) {
          return {
            success: false,
            error: `Engine returned ${status}`,
          };
        }

        if (attempt === ATTEMPTS) {
          return {
            success: false,
            error: `Engine returned ${status} after retry`,
          };
        }
      } catch (err: any) {
        this.logger.error(
          `Engine request failed on attempt ${attempt}: ${err.message}`,
        );
        if (attempt === ATTEMPTS) {
          return {
            success: false,
            error: `Engine request failed: ${err.message}`,
          };
        }
      }
    }

    return { success: false, error: 'Engine call failed' };
  }
}
