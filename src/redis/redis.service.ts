import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.service';
import {
  Color,
  GameState,
  GameFinishedEvent,
  UserPlayer,
} from '../domain/types';

export interface UserStatus {
  status: 'idle' | 'queue' | 'game';
  gameId?: string;
}

/** An event of the outbox with the JSON that it is stored as, which removing it needs. */
export interface OutboxEntry {
  json: string;
  event: GameFinishedEvent;
}

/** A clock that runs in a game. */
export interface RunningClock {
  gameId: string;
  color: Color;
}

// The list of the outbox. New events go to its head, so the oldest one is at its tail.
const OUTBOX_KEY = 'outbox:events';

// The deadlines of the running clocks as a sorted set, with members such as `<gameId>:white` and the time in
// milliseconds at which the clock runs out as their scores.
const DEADLINES_KEY = 'game:deadlines';

// The users who wait for an opponent as the JSON of their players, with the one who has waited the longest at the head.
const QUEUE_KEY = 'queue:players';

const statusKey = (userId: string) => `user:status:${userId}`;
const gameKey = (gameId: string) => `game:${gameId}`;

// A user who waits or plays can neither join the queue nor start a game (ADR-10). KEYS[1] is the status of the user.
const FREE_USER = `
  local status = redis.call('GET', KEYS[1])
  if status == 'queue' then
    return 'alreadyInQueue'
  end
  if status then
    return 'alreadyInGame'
  end
`;

// KEYS are the status of the user, the game and the deadlines. ARGV are the game as JSON, its id, and the deadline
// member of the running clock or an empty string with the score of the deadline.
const START_GAME_SCRIPT = `${FREE_USER}
  redis.call('SET', KEYS[2], ARGV[1])
  redis.call('SET', KEYS[1], 'game:' .. ARGV[2])
  if ARGV[3] ~= '' then
    redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
  end
  return 'started'
`;

// KEYS are the status of the user and the queue, and when a user waits, the status of that user, the new game and the
// deadlines. ARGV are the user as JSON and the waiting user as the queue holds it or an empty string, and when a user
// waits, the game as JSON, its id, and the deadline member of the clock of white with its score. The caller read the
// head of the queue before, so a head that has changed since then makes the caller read it again. A head whose user
// does not wait any more is dropped from the queue, and the caller reads it again too.
const JOIN_QUEUE_SCRIPT = `${FREE_USER}
  local head = redis.call('LINDEX', KEYS[2], 0) or ''
  if head ~= ARGV[2] then
    return 'queueChanged'
  end
  if head == '' then
    redis.call('SET', KEYS[1], 'queue')
    redis.call('RPUSH', KEYS[2], ARGV[1])
    return 'queued'
  end
  redis.call('LPOP', KEYS[2])
  if redis.call('GET', KEYS[3]) ~= 'queue' then
    return 'queueChanged'
  end
  redis.call('SET', KEYS[4], ARGV[3])
  redis.call('SET', KEYS[1], 'game:' .. ARGV[4])
  redis.call('SET', KEYS[3], 'game:' .. ARGV[4])
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[5])
  return 'matched'
`;

// KEYS are the status of the user and the queue. ARGV is the id of the user.
const LEAVE_QUEUE_SCRIPT = `
  if redis.call('GET', KEYS[1]) ~= 'queue' then
    return 0
  end
  redis.call('DEL', KEYS[1])
  for _, json in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
    if cjson.decode(json).userId == ARGV[1] then
      redis.call('LREM', KEYS[2], 1, json)
      break
    end
  end
  return 1
`;

// Both scripts change a game only if it is still stored with the number of moves that the caller read. A game that has
// ended is deleted, so a late event finds no game.
const UNCHANGED_GAME = `
  local stored = redis.call('GET', KEYS[1])
  if not stored or #cjson.decode(stored).moves ~= tonumber(ARGV[1]) then
    return 0
  end
`;

// KEYS are the game and the deadlines. ARGV are the stored number of moves, the game as JSON, the id of the game, and
// the deadline member of the running clock or an empty string with the score of the deadline.
const SAVE_MOVE_SCRIPT = `${UNCHANGED_GAME}
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3] .. ':white', ARGV[3] .. ':black')
  if ARGV[4] ~= '' then
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
  end
  return 1
`;

/** The member and the score of the deadline of the running clock, or an empty member while no clock runs. */
function deadlineOf(game: GameState): [string, number] {
  const running = game.clock.running;
  const remainingMs = running ? game.clock[`${running}Ms`] : undefined;
  return running && remainingMs !== undefined
    ? [`${game.gameId}:${running}`, Date.now() + remainingMs]
    : ['', 0];
}

export type StartRefusal = 'alreadyInQueue' | 'alreadyInGame';

export type JoinOutcome = StartRefusal | 'queued' | 'matched' | 'queueChanged';

/** A user who waits in the queue, with the JSON that the queue holds. */
export interface WaitingUser {
  json: string;
  player: UserPlayer;
}

// KEYS are the game, the deadlines, the outbox and the statuses of the users who play the game. ARGV are the stored
// number of moves, the event as JSON and the id of the game. A status is deleted only while it still names this game.
const FINISH_GAME_SCRIPT = `${UNCHANGED_GAME}
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[3] .. ':white', ARGV[3] .. ':black')
  for i = 4, #KEYS do
    if redis.call('GET', KEYS[i]) == 'game:' .. ARGV[3] then
      redis.call('DEL', KEYS[i])
    end
  end
  redis.call('LPUSH', KEYS[3], ARGV[2])
  return 1
`;

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

  /**
   * Retrieves current status of a user (idle, waiting in queue, or in a game).
   */
  async getUserStatus(userId: string): Promise<UserStatus> {
    const val = await this.client.get(statusKey(userId));
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

  /** The user who has waited the longest, whom `joinQueue` pairs with the next user. */
  async peekQueue(): Promise<WaitingUser | undefined> {
    const json = await this.client.lindex(QUEUE_KEY, 0);
    return json ? { json, player: JSON.parse(json) as UserPlayer } : undefined;
  }

  /**
   * Puts a free user into the queue, or pairs the user with the waiting user that `peekQueue` returned and stores their
   * new game, in one script (ADR-3). It answers `queueChanged` and changes nothing else when the queue no longer starts
   * with that waiting user.
   */
  async joinQueue(
    player: UserPlayer,
    pairing?: { waiting: WaitingUser; game: GameState },
  ): Promise<JoinOutcome> {
    const keys = [statusKey(player.userId), QUEUE_KEY];
    const args: (string | number)[] = [
      JSON.stringify(player),
      pairing?.waiting.json ?? '',
    ];
    if (pairing) {
      const { waiting, game } = pairing;
      keys.push(
        statusKey(waiting.player.userId),
        gameKey(game.gameId),
        DEADLINES_KEY,
      );
      args.push(JSON.stringify(game), game.gameId, ...deadlineOf(game));
    }
    return (await this.client.eval(
      JOIN_QUEUE_SCRIPT,
      keys.length,
      ...keys,
      ...args,
    )) as JoinOutcome;
  }

  /** Takes a waiting user out of the queue. Returns false when the user does not wait, for example after a pairing. */
  async leaveQueue(userId: string): Promise<boolean> {
    const left = await this.client.eval(
      LEAVE_QUEUE_SCRIPT,
      2,
      statusKey(userId),
      QUEUE_KEY,
      userId,
    );
    return left === 1;
  }

  /** Stores a new game of a user against the bot if the user is free, and returns the refusal otherwise (ADR-10). */
  async startGame(
    userId: string,
    game: GameState,
  ): Promise<StartRefusal | undefined> {
    const answer = await this.client.eval(
      START_GAME_SCRIPT,
      3,
      statusKey(userId),
      gameKey(game.gameId),
      DEADLINES_KEY,
      JSON.stringify(game),
      game.gameId,
      ...deadlineOf(game),
    );
    return answer === 'started' ? undefined : (answer as StartRefusal);
  }

  /**
   * Loads a game from Redis.
   */
  async getGame(gameId: string): Promise<GameState | null> {
    const data = await this.client.get(gameKey(gameId));
    if (!data) return null;
    return JSON.parse(data) as GameState;
  }

  /**
   * Saves a game that goes on after a move, with the deadline of the clock that runs now. It returns false and changes
   * nothing when the stored game has ended or has another number of moves than `storedMoveCount`, because another
   * event changed it since it was read (ADR-3).
   */
  async saveMove(game: GameState, storedMoveCount: number): Promise<boolean> {
    const saved = await this.client.eval(
      SAVE_MOVE_SCRIPT,
      2,
      gameKey(game.gameId),
      DEADLINES_KEY,
      storedMoveCount,
      JSON.stringify(game),
      game.gameId,
      ...deadlineOf(game),
    );
    return saved === 1;
  }

  /**
   * Ends a game. It deletes the game, its deadlines and the statuses of its users, and it adds the event of the end to
   * the outbox (ADR-6). Redis runs a script as a whole, so neither a lost connection nor a restart of Redis can leave a
   * finished game without its event. Like `saveMove`, it returns false and changes nothing when the stored game has
   * ended or changed since it was read, so a game ends only once.
   */
  async finishGame(
    game: GameState,
    storedMoveCount: number,
    event: GameFinishedEvent,
  ): Promise<boolean> {
    const statusKeys = [game.white, game.black].flatMap((player) =>
      player.kind === 'user' ? [statusKey(player.userId)] : [],
    );
    const finished = await this.client.eval(
      FINISH_GAME_SCRIPT,
      3 + statusKeys.length,
      gameKey(game.gameId),
      DEADLINES_KEY,
      OUTBOX_KEY,
      ...statusKeys,
      storedMoveCount,
      JSON.stringify(event),
      game.gameId,
    );
    return finished === 1;
  }

  /**
   * The clocks that have run out by `now`. A deadline stays until the script that saves the next move or ends the game
   * replaces or removes it.
   */
  async getExpiredClocks(now: number): Promise<RunningClock[]> {
    const members = await this.client.zrange(
      DEADLINES_KEY,
      '-inf',
      String(now),
      'BYSCORE',
    );
    return members.map((member) => {
      const separator = member.lastIndexOf(':');
      return {
        gameId: member.slice(0, separator),
        color: member.slice(separator + 1) as Color,
      };
    });
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
