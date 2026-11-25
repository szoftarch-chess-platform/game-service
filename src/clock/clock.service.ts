import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';

// How often every instance looks for the deadlines that have passed (GS-ADR-3).
const CHECK_INTERVAL_MS = 1000;

@Injectable()
export class ClockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClockService.name);
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;

  constructor(
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.checkExpiredDeadlines().catch((err) => {
        this.logger.error(`Error checking clock deadlines: ${err.message}`);
      });
    }, CHECK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Ends the games whose clock has run out, and asks the engine again for the moves of the bot that have not come in
   * time. A deadline stays until a move or the end of its game replaces it, so a deadline whose handling fails, for
   * example because Redis cannot be reached, is handled at a later check (ADR-10).
   */
  async checkExpiredDeadlines() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const expired = await this.redisService.getExpiredDeadlines(Date.now());
      // A deadline whose handling fails does not hold up the others.
      await Promise.all(
        expired.map(({ gameId, color }) =>
          this.gameService.handleExpiredDeadline(gameId, color).catch((err) => {
            this.logger.error(
              `The deadline of ${color} in game ${gameId} failed: ${err.message}`,
            );
          }),
        ),
      );
    } finally {
      this.isChecking = false;
    }
  }
}
