import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CommandParser, createClient, defineScript } from '@redis/client';
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

/**
 * The time in milliseconds at which the clock of a color runs out, or by which the bot that plays the color has to
 * have moved (GS-ADR-3).
 */
export interface Deadline {
  color: Color;
  at: number;
}

/** A deadline of a game that has passed. */
export interface PassedDeadline {
  gameId: string;
  color: Color;
}

export type StartRefusal = 'alreadyInQueue' | 'alreadyInGame';

export type JoinOutcome = StartRefusal | 'queued' | 'matched' | 'queueChanged';

/** A user who waits in the queue, with the JSON that the queue holds. */
export interface WaitingUser {
  json: string;
  player: UserPlayer;
}

/** The waiting user whom the user who joins plays, with their new game and its first deadline. */
export interface Pairing {
  waiting: WaitingUser;
  game: GameState;
  deadline: Deadline;
}

// A command that cannot be sent within this time, for example while the connection is lost, fails and is never sent,
// so an event does not change a game after its client has stopped waiting for the answer.
export const COMMAND_TIMEOUT_MS = 5000;

// The list of the outbox. New events go to its head, so the oldest one is at its tail.
const OUTBOX_KEY = 'outbox:events';

// The deadlines of the games as a sorted set, with members such as `<gameId>:white` and the time of the deadline in
// milliseconds as their scores.
const DEADLINES_KEY = 'game:deadlines';

// The users who wait for an opponent as the JSON of their players. A user who joins is paired with the head at once, so
// the list holds at most one user.
const QUEUE_KEY = 'queue:players';

const statusKey = (userId: string) => `user:status:${userId}`;
const gameKey = (gameId: string) => `game:${gameId}`;
const deadlineMember = (gameId: string, color: Color) => `${gameId}:${color}`;

/** The member and the score of a deadline as the arguments of a script. */
const deadlineArguments = (gameId: string, { color, at }: Deadline) => [
  deadlineMember(gameId, color),
  String(at),
];

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

// KEYS are the status of the user, the game and the deadlines. ARGV are the game as JSON, its id, and the member and
// the score of its first deadline.
const START_GAME_SCRIPT = `${FREE_USER}
  redis.call('SET', KEYS[2], ARGV[1])
  redis.call('SET', KEYS[1], 'game:' .. ARGV[2])
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
  return 'started'
`;

// KEYS are the status of the user and the queue, and when a user waits, the status of that user, the new game and the
// deadlines. ARGV are the user as JSON and the waiting user as the queue holds it or an empty string, and when a user
// waits, the game as JSON, its id, and the member and the score of its first deadline. The caller read the head of the
// queue before, so a head that has changed since then makes the caller read it again. A head whose user does not wait
// any more is dropped from the queue, and the caller reads it again too.
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
// the member and the score of its next deadline.
const SAVE_MOVE_SCRIPT = `${UNCHANGED_GAME}
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3] .. ':white', ARGV[3] .. ':black')
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
  return 1
`;

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

// KEYS is the deadlines. ARGV are the member, the time now and the later score. Only the first caller moves a deadline
// that has passed, because the deadline has not passed any more for the next one.
const CLAIM_DEADLINE_SCRIPT = `
  local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if not score or tonumber(score) > tonumber(ARGV[2]) then
    return 0
  end
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
  return 1
`;

/** A Lua script that node-redis runs with EVALSHA, and with EVAL while Redis does not know it yet (GS-ADR-3). */
function luaScript<R, T>(source: string, transformReply: (reply: R) => T) {
  return defineScript({
    SCRIPT: source,
    parseCommand(parser: CommandParser, keys: string[], args: string[]) {
      parser.pushKeysLength(keys);
      parser.push(...args);
    },
    transformReply,
  });
}

const isOne = (reply: number) => reply === 1;

const scripts = {
  startGame: luaScript(START_GAME_SCRIPT, (reply: 'started' | StartRefusal) =>
    reply === 'started' ? undefined : reply,
  ),
  joinQueue: luaScript(JOIN_QUEUE_SCRIPT, (reply: JoinOutcome) => reply),
  leaveQueue: luaScript(LEAVE_QUEUE_SCRIPT, isOne),
  saveMove: luaScript(SAVE_MOVE_SCRIPT, isOne),
  finishGame: luaScript(FINISH_GAME_SCRIPT, isOne),
  claimDeadline: luaScript(CLAIM_DEADLINE_SCRIPT, isOne),
};

const createRedisClient = (url: string) =>
  createClient({
    url,
    scripts,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
  });

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: ReturnType<typeof createRedisClient>;

  constructor(config: AppConfigService) {
    this.client = createRedisClient(config.redisUrl);
    // An error without a listener would end the process. The client connects again by itself.
    this.client.on('error', (err: Error) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
  }

  /** Waits until Redis can be reached, because the client keeps trying to connect. */
  async onModuleInit() {
    await this.client.connect();
  }

  /** Closes the connection once the commands that were sent have their answers. */
  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.close();
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
    const json = await this.client.lIndex(QUEUE_KEY, 0);
    return json ? { json, player: JSON.parse(json) as UserPlayer } : undefined;
  }

  /**
   * Puts a free user into the queue, or pairs the user with the waiting user that `peekQueue` returned and stores their
   * new game, in one script (ADR-3). It answers `queueChanged` and changes nothing else when the queue no longer starts
   * with that waiting user.
   */
  async joinQueue(player: UserPlayer, pairing?: Pairing): Promise<JoinOutcome> {
    const keys = [statusKey(player.userId), QUEUE_KEY];
    const args = [JSON.stringify(player), pairing?.waiting.json ?? ''];
    if (pairing) {
      const { waiting, game, deadline } = pairing;
      keys.push(
        statusKey(waiting.player.userId),
        gameKey(game.gameId),
        DEADLINES_KEY,
      );
      args.push(
        JSON.stringify(game),
        game.gameId,
        ...deadlineArguments(game.gameId, deadline),
      );
    }
    return this.client.joinQueue(keys, args);
  }

  /** Takes a waiting user out of the queue. Returns false when the user does not wait, for example after a pairing. */
  async leaveQueue(userId: string): Promise<boolean> {
    return this.client.leaveQueue([statusKey(userId), QUEUE_KEY], [userId]);
  }

  /** Stores a new game of a user against the bot if the user is free, and returns the refusal otherwise (ADR-10). */
  async startGame(
    userId: string,
    game: GameState,
    deadline: Deadline,
  ): Promise<StartRefusal | undefined> {
    return this.client.startGame(
      [statusKey(userId), gameKey(game.gameId), DEADLINES_KEY],
      [
        JSON.stringify(game),
        game.gameId,
        ...deadlineArguments(game.gameId, deadline),
      ],
    );
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
   * Saves a game that goes on after a move, with the deadline that it waits for next. It returns false and changes
   * nothing when the stored game has ended or has another number of moves than `storedMoveCount`, because another
   * event changed it since it was read (ADR-3).
   */
  async saveMove(
    game: GameState,
    storedMoveCount: number,
    deadline: Deadline,
  ): Promise<boolean> {
    return this.client.saveMove(
      [gameKey(game.gameId), DEADLINES_KEY],
      [
        String(storedMoveCount),
        JSON.stringify(game),
        game.gameId,
        ...deadlineArguments(game.gameId, deadline),
      ],
    );
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
    return this.client.finishGame(
      [gameKey(game.gameId), DEADLINES_KEY, OUTBOX_KEY, ...statusKeys],
      [String(storedMoveCount), JSON.stringify(event), game.gameId],
    );
  }

  /**
   * The deadlines that have passed by `now`. A deadline stays until the script that saves the next move or ends the
   * game replaces or removes it.
   */
  async getExpiredDeadlines(now: number): Promise<PassedDeadline[]> {
    const members = await this.client.zRange(DEADLINES_KEY, '-inf', now, {
      BY: 'SCORE',
    });
    return members.map((member) => {
      const separator = member.lastIndexOf(':');
      return {
        gameId: member.slice(0, separator),
        color: member.slice(separator + 1) as Color,
      };
    });
  }

  /**
   * Moves a deadline that has passed by `now` to `until`, and returns whether this call moved it. So only one instance
   * takes over the work of the deadline, and when that instance fails, the moved deadline passes and another instance
   * takes the work over.
   */
  async claimDeadline(
    gameId: string,
    color: Color,
    now: number,
    until: number,
  ): Promise<boolean> {
    return this.client.claimDeadline(
      [DEADLINES_KEY],
      [deadlineMember(gameId, color), String(now), String(until)],
    );
  }

  /**
   * Returns the oldest event of the outbox without removing it. It stays in the outbox until the broker has confirmed
   * it, so a crash or a refused publish does not lose it (ADR-6).
   */
  async peekOutboxEvent(): Promise<OutboxEntry | null> {
    const json = await this.client.lIndex(OUTBOX_KEY, -1);
    if (!json) return null;
    return { json, event: JSON.parse(json) as GameFinishedEvent };
  }

  /**
   * Removes an event that the broker has confirmed. LREM looks for its stored JSON from the tail instead of popping the
   * tail, so it never removes another event, even when another instance has removed this one already.
   */
  async removeOutboxEvent(json: string): Promise<void> {
    await this.client.lRem(OUTBOX_KEY, -1, json);
  }
}
