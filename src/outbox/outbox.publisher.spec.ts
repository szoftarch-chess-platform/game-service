import { EventEmitter } from 'node:events';
import * as amqp from 'amqplib';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OutboxPublisher, RETRY_DELAY_MS } from './outbox.publisher';
import { AppConfigService } from '../config/config.service';
import { OutboxEntry, RedisService } from '../redis/redis.service';
import { GameFinishedEvent } from '../domain/types';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

type Confirm = (err: Error | null) => void;

type TestChannel = EventEmitter & { publish: ReturnType<typeof vi.fn> };

const testEvent: GameFinishedEvent = {
  id: '0193c2c0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  type: 'game.finished.v1',
  source: 'game-service',
  time: '2026-11-20T14:03:12.345Z',
  data: {
    gameId: 'game-1',
    variant: 'standard',
    white: { kind: 'user', userId: 'u1', name: 'Alice' },
    black: { kind: 'user', userId: 'u2', name: 'Bob' },
    result: 'whiteWon',
    reason: 'checkmate',
    moves: ['e2e4'],
    timeControl: { initialMs: 600000 },
    startedAt: '2026-11-20T14:01:40.120Z',
    endedAt: '2026-11-20T14:03:12.345Z',
  },
};

const entry: OutboxEntry = {
  json: JSON.stringify(testEvent),
  event: testEvent,
};

/** A confirm channel of amqplib whose broker answers every publish with the given function. */
function channelThatAnswers(
  answer: (channel: TestChannel, confirm: Confirm) => void,
): TestChannel {
  const channel = new EventEmitter() as TestChannel;
  channel.publish = vi.fn(
    (_exchange, _routingKey, _content, _options, confirm: Confirm) =>
      answer(channel, confirm),
  );
  return channel;
}

/** A message that the broker returns as unroutable. */
function returned(messageId: string) {
  return { properties: { messageId } };
}

/** A connection of amqplib with one confirm channel. */
class FakeConnection extends EventEmitter {
  readonly channel = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn().mockResolvedValue({}),
  });

  readonly createConfirmChannel = vi.fn().mockResolvedValue(this.channel);

  // Like amqplib, it closes the channels of the connection before the connection itself.
  readonly close = vi.fn(async () => {
    this.channel.emit('close');
    this.emit('close');
  });

  /** The broker closes the connection, for example when it restarts. */
  lose() {
    this.channel.emit('close');
    this.emit('close');
  }
}

describe('OutboxPublisher', () => {
  let publisher: OutboxPublisher;
  let mockRedis: any;

  function useChannel(channel: TestChannel) {
    (publisher as any).channel = channel;
  }

  // The outbox gives the event once and is empty after it, so a fault that keeps publishing makes the test fail
  // instead of looping forever.
  function outboxHoldsOnce(outboxEntry: OutboxEntry) {
    mockRedis.peekOutboxEvent
      .mockResolvedValueOnce(outboxEntry)
      .mockResolvedValue(null);
  }

  beforeEach(() => {
    mockRedis = {
      peekOutboxEvent: vi.fn(),
      removeOutboxEvent: vi.fn(),
    };

    const mockConfig = {
      rabbitmqUrl: 'amqp://localhost:5672',
    } as AppConfigService;

    publisher = new OutboxPublisher(mockConfig, mockRedis as RedisService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the oldest event with confirms and removes it from the outbox', async () => {
    const channel = channelThatAnswers((_, confirm) => confirm(null));
    useChannel(channel);
    outboxHoldsOnce(entry);

    await publisher.drainOutbox();

    expect(channel.publish).toHaveBeenCalledWith(
      'game.events',
      'game.finished',
      expect.any(Buffer),
      expect.objectContaining({
        mandatory: true,
        deliveryMode: 2,
        messageId: testEvent.id,
        type: 'game.finished.v1',
      }),
      expect.any(Function),
    );
    expect(mockRedis.removeOutboxEvent).toHaveBeenCalledWith(entry.json);
    expect(channel.listenerCount('return')).toBe(0);
  });

  it('removes the event only after the broker has confirmed it', async () => {
    let confirmLater: Confirm | undefined;
    useChannel(
      channelThatAnswers((_, confirm) => {
        confirmLater = confirm;
      }),
    );
    outboxHoldsOnce(entry);

    const draining = publisher.drainOutbox();
    await vi.waitFor(() => expect(confirmLater).toBeDefined());

    expect(mockRedis.removeOutboxEvent).not.toHaveBeenCalled();

    confirmLater!(null);
    await draining;

    expect(mockRedis.removeOutboxEvent).toHaveBeenCalledWith(entry.json);
  });

  it('keeps the event in the outbox and pauses when the broker nacks it', async () => {
    useChannel(
      channelThatAnswers((_, confirm) => confirm(new Error('message nacked'))),
    );
    outboxHoldsOnce(entry);

    await publisher.drainOutbox();
    await publisher.drainOutbox();

    expect(mockRedis.removeOutboxEvent).not.toHaveBeenCalled();
    expect(mockRedis.peekOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps the event in the outbox when the broker returns it', async () => {
    const channel = channelThatAnswers((answering, confirm) => {
      answering.emit('return', returned(testEvent.id));
      confirm(null);
    });
    useChannel(channel);
    outboxHoldsOnce(entry);

    await publisher.drainOutbox();

    expect(mockRedis.removeOutboxEvent).not.toHaveBeenCalled();
    expect(channel.listenerCount('return')).toBe(0);
  });

  it('notices its own return after the return of another event', async () => {
    useChannel(
      channelThatAnswers((answering, confirm) => {
        answering.emit('return', returned('another-event'));
        answering.emit('return', returned(testEvent.id));
        confirm(null);
      }),
    );
    outboxHoldsOnce(entry);

    await publisher.drainOutbox();

    expect(mockRedis.removeOutboxEvent).not.toHaveBeenCalled();
  });

  it('keeps the event in the outbox when the channel is closed', async () => {
    const channel = channelThatAnswers(() => {
      throw new Error('Channel closed');
    });
    useChannel(channel);
    outboxHoldsOnce(entry);

    await publisher.drainOutbox();

    expect(mockRedis.removeOutboxEvent).not.toHaveBeenCalled();
    expect(channel.listenerCount('return')).toBe(0);
  });
});

describe('OutboxPublisher connection', () => {
  let publisher: OutboxPublisher;
  let connections: FakeConnection[];

  function openConnection(): FakeConnection {
    const connection = new FakeConnection();
    connections.push(connection);
    return connection;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    connections = [];
    vi.mocked(amqp.connect).mockImplementation(
      async () => openConnection() as unknown as amqp.ChannelModel,
    );

    const config = { rabbitmqUrl: 'amqp://localhost:5672' } as AppConfigService;
    const redis = {
      peekOutboxEvent: vi.fn().mockResolvedValue(null),
    } as unknown as RedisService;
    publisher = new OutboxPublisher(config, redis);
  });

  afterEach(async () => {
    await publisher.onModuleDestroy();
    vi.mocked(amqp.connect).mockReset();
    vi.useRealTimers();
  });

  it('connects again after the broker closes the connection', async () => {
    await publisher.onModuleInit();

    connections[0].lose();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(connections).toHaveLength(2);
  });

  it('closes the connection and connects again when the broker closes only the channel', async () => {
    await publisher.onModuleInit();

    connections[0].channel.emit('close');
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(connections[0].close).toHaveBeenCalled();
    expect(connections).toHaveLength(2);
  });

  it('closes a connection whose setup fails and connects again only once', async () => {
    vi.mocked(amqp.connect).mockImplementationOnce(async () => {
      const connection = openConnection();
      connection.channel.assertExchange.mockRejectedValue(
        new Error('ACCESS_REFUSED'),
      );
      return connection as unknown as amqp.ChannelModel;
    });

    await publisher.onModuleInit();
    expect(connections[0].close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 3);

    expect(connections).toHaveLength(2);
  });

  it('does not connect again after the stop', async () => {
    await publisher.onModuleInit();

    await publisher.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 3);

    expect(connections[0].close).toHaveBeenCalled();
    expect(connections).toHaveLength(1);
  });

  it('closes a connection that opens only after the stop', async () => {
    await publisher.onModuleInit();
    let openLate!: (connection: amqp.ChannelModel) => void;
    vi.mocked(amqp.connect).mockImplementationOnce(
      () =>
        new Promise<amqp.ChannelModel>((resolve) => {
          openLate = resolve;
        }),
    );
    connections[0].lose();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    await publisher.onModuleDestroy();
    const late = new FakeConnection();
    openLate(late as unknown as amqp.ChannelModel);
    await vi.advanceTimersByTimeAsync(0);

    expect(late.close).toHaveBeenCalled();
  });
});
