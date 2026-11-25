import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameService } from '../game/game.service';
import { RedisService } from '../redis/redis.service';
import { ClockService } from './clock.service';

describe('ClockService', () => {
  let redisService: { getExpiredClocks: ReturnType<typeof vi.fn> };
  let gameService: { handleTimeout: ReturnType<typeof vi.fn> };
  let service: ClockService;

  beforeEach(() => {
    redisService = { getExpiredClocks: vi.fn() };
    gameService = { handleTimeout: vi.fn().mockResolvedValue(undefined) };
    service = new ClockService(
      redisService as unknown as RedisService,
      gameService as unknown as GameService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends every game whose clock has run out by now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    redisService.getExpiredClocks.mockResolvedValue([
      { gameId: 'game-1', color: 'white' },
      { gameId: 'game-2', color: 'black' },
    ]);

    await service.checkExpiredDeadlines();

    expect(redisService.getExpiredClocks).toHaveBeenCalledWith(5000);
    expect(gameService.handleTimeout).toHaveBeenCalledWith('game-1', 'white');
    expect(gameService.handleTimeout).toHaveBeenCalledWith('game-2', 'black');
  });

  it('ends the other games when the end of one fails', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    redisService.getExpiredClocks.mockResolvedValue([
      { gameId: 'game-1', color: 'white' },
      { gameId: 'game-2', color: 'black' },
    ]);
    gameService.handleTimeout.mockRejectedValueOnce(
      new Error('Redis is down.'),
    );

    await service.checkExpiredDeadlines();

    expect(gameService.handleTimeout).toHaveBeenCalledWith('game-2', 'black');
    expect(logged).toHaveBeenCalledWith(
      'Ending game game-1 on time failed: Redis is down.',
    );
  });

  it('does not start a check while the previous one runs', async () => {
    let finish!: () => void;
    redisService.getExpiredClocks.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
    );

    const first = service.checkExpiredDeadlines();
    await service.checkExpiredDeadlines();
    finish();
    await first;

    expect(redisService.getExpiredClocks).toHaveBeenCalledTimes(1);
  });
});
