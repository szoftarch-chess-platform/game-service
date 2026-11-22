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
import { Color } from '../domain/types';

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
    }, 1000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async checkExpiredDeadlines() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const now = Date.now();
      const expiredMembers = await this.redisService.getExpiredDeadlines(now);

      for (const member of expiredMembers) {
        const removed = await this.redisService.removeDeadline(member);
        if (removed > 0) {
          const [gameId, color] = member.split(':');
          if (gameId && color) {
            this.logger.log(`Game ${gameId} timed out on ${color}`);
            await this.gameService.handleTimeout(gameId, color as Color);
          }
        }
      }
    } finally {
      this.isChecking = false;
    }
  }
}
