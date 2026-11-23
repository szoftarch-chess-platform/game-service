import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.service';
import { GameState, GameFinishedEvent, UserPlayer } from '../domain/types';

export interface UserStatus {
  status: 'idle' | 'queue' | 'game';
  gameId?: string;
}

/** An event of the outbox with the JSON that it is stored as, which removing it needs. */
export interface OutboxEntry {
  json: string;
  event: GameFinishedEvent;
}

// The list of the outbox. New events go to its head, so the oldest one is at its tail.
const OUTBOX_KEY = 'outbox:events';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit() {
    this.client = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => {});
    }
  }

  // Exposed for tests or direct operations
  getClient(): Redis {
    return this.client;
  }

  setClient(client: Redis) {
    this.client = client;
  }

  /**
   * Retrieves current status of a user (idle, waiting in queue, or in a game).
   */
  async getUserStatus(userId: string): Promise<UserStatus> {
    const val = await this.client.get(`user:status:${userId}`);
    if (!val) {
      return { status: 'idle' };
    }
    if (val === 'queue') {
      return { status: 'queue' };
    }
    if (val.startsWith('game:')) {
      return { status: 'game', gameId: val.slice(5) };
    }
    return { status: 'idle' };
  }

  /**
   * Atomically joins the queue if the user is not already queued or in a game.
   * If at least 2 players are in queue, pops the two oldest (FIFO) and returns them.
   */
  async joinQueue(player: UserPlayer): Promise<{
    error?: 'alreadyInQueue' | 'alreadyInGame';
    matched?: [UserPlayer, UserPlayer];
  }> {
    const joinScript = `
      local userId = KEYS[1]
      local playerJson = ARGV[1]
      local currentStatus = redis.call('GET', 'user:status:' .. userId)
      if currentStatus then
        if currentStatus == 'queue' then return {'error', 'alreadyInQueue'} end
        if string.sub(currentStatus, 1, 5) == 'game:' then return {'error', 'alreadyInGame'} end
      end
      redis.call('SET', 'user:status:' .. userId, 'queue')
      redis.call('RPUSH', 'queue:players', playerJson)
      local len = redis.call('LLEN', 'queue:players')
      if len >= 2 then
        local p1 = redis.call('LPOP', 'queue:players')
        local p2 = redis.call('LPOP', 'queue:players')
        return {'matched', p1, p2}
      end
      return {'ok'}
    `;

    const result = (await this.client.eval(
      joinScript,
      1,
      player.userId,
      JSON.stringify(player),
    )) as [string, string, string?] | null;

    if (result) {
      if (result[0] === 'error') {
        return { error: result[1] as 'alreadyInQueue' | 'alreadyInGame' };
      }
      if (result[0] === 'matched' && result[1] && result[2]) {
        const p1 = JSON.parse(result[1]) as UserPlayer;
        const p2 = JSON.parse(result[2]) as UserPlayer;
        return { matched: [p1, p2] };
      }
    }

    return {};
  }

  /**
   * Removes user from queue if present.
   */
  async leaveQueue(userId: string): Promise<boolean> {
    const status = await this.getUserStatus(userId);
    if (status.status !== 'queue') {
      return false;
    }

    // Lua script to atomically remove player from queue and del status
    const leaveScript = `
      local userId = KEYS[1]
      redis.call('DEL', 'user:status:' .. userId)
      local players = redis.call('LRANGE', 'queue:players', 0, -1)
      for i, pJson in ipairs(players) do
        local p = cjson.decode(pJson)
        if p.userId == userId then
          redis.call('LREM', 'queue:players', 1, pJson)
          break
        end
      end
      return 1
    `;

    await this.client.eval(leaveScript, 1, userId);
    return true;
  }

  /**
   * Stores a new game in Redis, sets user statuses, and sets initial clock deadline if running.
   */
  async createGame(game: GameState): Promise<void> {
    const pipeline = this.client.pipeline();

    pipeline.set(`game:${game.gameId}`, JSON.stringify(game));

    if (game.white.kind === 'user') {
      pipeline.set(`user:status:${game.white.userId}`, `game:${game.gameId}`);
    }
    if (game.black.kind === 'user') {
      pipeline.set(`user:status:${game.black.userId}`, `game:${game.gameId}`);
    }

    // Set clock deadline if clock is running
    if (game.clock.running) {
      const remainingMs =
        game.clock.running === 'white'
          ? (game.clock.whiteMs ?? 600000)
          : (game.clock.blackMs ?? 600000);
      const deadline = Date.now() + remainingMs;
      pipeline.zadd(
        'game:deadlines',
        deadline,
        `${game.gameId}:${game.clock.running}`,
      );
    }

    await pipeline.exec();
  }

  /**
   * Loads a game from Redis.
   */
  async getGame(gameId: string): Promise<GameState | null> {
    const data = await this.client.get(`game:${gameId}`);
    if (!data) return null;
    return JSON.parse(data) as GameState;
  }

  /**
   * Updates game state after a move or state change.
   * If finished, clears user statuses, cleans up clock deadlines, and writes to outbox in the same transaction (ADR-6).
   * Redis runs the commands of MULTI and EXEC together, so a lost connection or a restart of Redis cannot leave a
   * finished game without its event, as a pipeline could.
   */
  async saveGameState(
    game: GameState,
    isFinished: boolean,
    outboxEvent?: GameFinishedEvent,
  ): Promise<void> {
    const transaction = this.client.multi();

    transaction.set(`game:${game.gameId}`, JSON.stringify(game));

    // Clear any existing deadlines for this game
    transaction.zrem(
      'game:deadlines',
      `${game.gameId}:white`,
      `${game.gameId}:black`,
    );

    if (isFinished) {
      if (game.white.kind === 'user') {
        transaction.del(`user:status:${game.white.userId}`);
      }
      if (game.black.kind === 'user') {
        transaction.del(`user:status:${game.black.userId}`);
      }
      if (outboxEvent) {
        transaction.lpush(OUTBOX_KEY, JSON.stringify(outboxEvent));
      }
    } else if (game.clock.running) {
      const remainingMs =
        game.clock.running === 'white'
          ? (game.clock.whiteMs ?? 600000)
          : (game.clock.blackMs ?? 600000);
      const deadline = Date.now() + remainingMs;
      transaction.zadd(
        'game:deadlines',
        deadline,
        `${game.gameId}:${game.clock.running}`,
      );
    }

    await transaction.exec();
  }

  /**
   * Retrieves clock deadlines that have expired as of `now`.
   */
  async getExpiredDeadlines(now: number): Promise<string[]> {
    return this.client.zrangebyscore('game:deadlines', 0, now);
  }

  /**
   * Removes a specific deadline from the set. Returns number of removed elements (1 if removed).
   */
  async removeDeadline(member: string): Promise<number> {
    return this.client.zrem('game:deadlines', member);
  }

  /**
   * Returns the oldest event of the outbox without removing it. It stays in the outbox until the broker has confirmed
   * it, so a crash or a refused publish does not lose it (ADR-6).
   */
  async peekOutboxEvent(): Promise<OutboxEntry | null> {
    const json = await this.client.lindex(OUTBOX_KEY, -1);
    if (!json) return null;
    return { json, event: JSON.parse(json) as GameFinishedEvent };
  }

  /**
   * Removes an event that the broker has confirmed. LREM looks for its stored JSON from the tail instead of popping the
   * tail, so it never removes another event, even when another instance has removed this one already.
   */
  async removeOutboxEvent(json: string): Promise<void> {
    await this.client.lrem(OUTBOX_KEY, -1, json);
  }
}
