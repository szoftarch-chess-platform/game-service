import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

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
   * Calls engine-service POST /moves to get a move for the given FEN.
   * Enforces a 15-second timeout and 1 retry on 500 or network failure (ADR-6).
   */
  async requestMove(fen: string, variant = 'standard'): Promise<EngineMoveResponse> {
    const url = `${this.config.engineUrl}/moves`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fen, variant }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = (await response.json()) as { move: string };
          return { success: true, move: data.move };
        }

        const status = response.status;
        this.logger.warn(`Engine service returned HTTP ${status} on attempt ${attempt}`);

        // If client error (400 or 422), do not retry (ADR-6 / OpenAPI contract notes repeating gets same answer)
        if (status === 400 || status === 422) {
          return {
            success: false,
            error: `Engine returned ${status}`,
          };
        }

        // On 500, retry once
        if (attempt === 2) {
          return {
            success: false,
            error: `Engine returned ${status} after retry`,
          };
        }
      } catch (err: any) {
        this.logger.error(`Engine request failed on attempt ${attempt}: ${err.message}`);
        if (attempt === 2) {
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
