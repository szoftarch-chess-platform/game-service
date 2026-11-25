import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameService } from '../game/game.service';
import { RedisService } from '../redis/redis.service';
import { ClockService } from './clock.service';

describe('ClockService', () => {
  let redisService: { getExpiredDeadlines: ReturnType<typeof vi.fn> };
  let gameService: { handleExpiredDeadline: ReturnType<typeof vi.fn> };
  let service: ClockService;

  beforeEach(() => {
    redisService = { getExpiredDeadlines: vi.fn() };
    gameService = {
      handleExpiredDeadline: vi.fn().mockResolvedValue(undefined),
    };
    service = new ClockService(
      redisService as unknown as RedisService,
      gameService as unknown as GameService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles every deadline that has passed by now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    redisService.getExpiredDeadlines.mockResolvedValue([
      { gameId: 'game-1', color: 'white' },
      { gameId: 'game-2', color: 'black' },
    ]);

    await service.checkExpiredDeadlines();

    expect(redisService.getExpiredDeadlines).toHaveBeenCalledWith(5000);
    expect(gameService.handleExpiredDeadline).toHaveBeenCalledWith(
      'game-1',
      'white',
    );
    expect(gameService.handleExpiredDeadline).toHaveBeenCalledWith(
      'game-2',
      'black',
    );
  });

  it('handles the other deadlines when one of them fails', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    redisService.getExpiredDeadlines.mockResolvedValue([
      { gameId: 'game-1', color: 'white' },
      { gameId: 'game-2', color: 'black' },
    ]);
    gameService.handleExpiredDeadline.mockRejectedValueOnce(
      new Error('Redis is down.'),
    );

    await service.checkExpiredDeadlines();

    expect(gameService.handleExpiredDeadline).toHaveBeenCalledWith(
      'game-2',
      'black',
    );
    expect(logged).toHaveBeenCalledWith(
      'The deadline of white in game game-1 failed: Redis is down.',
    );
  });

  it('does not start a check while the previous one runs', async () => {
    let finish!: () => void;
    redisService.getExpiredDeadlines.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
    );

    const first = service.checkExpiredDeadlines();
    await service.checkExpiredDeadlines();
    finish();
    await first;

    expect(redisService.getExpiredDeadlines).toHaveBeenCalledTimes(1);
  });
});
