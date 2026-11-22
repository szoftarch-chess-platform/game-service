import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OutboxPublisher } from './outbox.publisher';
import { AppConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { GameFinishedEvent } from '../domain/types';

describe('OutboxPublisher', () => {
  let publisher: OutboxPublisher;
  let mockRedis: any;
  let mockChannel: any;

  beforeEach(() => {
    mockRedis = {
      popOutboxEvent: vi.fn(),
      requeueOutboxEvent: vi.fn(),
    };

    const mockConfig = {
      rabbitmqUrl: 'amqp://localhost:5672',
    } as AppConfigService;

    publisher = new OutboxPublisher(mockConfig, mockRedis as RedisService);

    mockChannel = {
      publish: vi.fn((exchange, routingKey, buffer, options, callback) => {
        callback(null); // successful confirm
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
    };

    (publisher as any).channel = mockChannel;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains event from Redis and publishes with confirms', async () => {
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

    mockRedis.popOutboxEvent
      .mockResolvedValueOnce(testEvent)
      .mockResolvedValueOnce(null);

    await publisher.drainOutbox();

    expect(mockRedis.popOutboxEvent).toHaveBeenCalled();
    expect(mockChannel.publish).toHaveBeenCalledWith(
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
    expect(mockRedis.requeueOutboxEvent).not.toHaveBeenCalled();
  });

  it('requeues event if publish fails', async () => {
    const testEvent: GameFinishedEvent = {
      id: '0193c2c0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      type: 'game.finished.v1',
      source: 'game-service',
      time: '2026-11-20T14:03:12.345Z',
      data: {} as any,
    };

    mockRedis.popOutboxEvent.mockResolvedValueOnce(testEvent);
    mockChannel.publish = vi.fn((exchange, routingKey, buffer, options, callback) => {
      callback(new Error('NACK'));
    });

    await publisher.drainOutbox();

    expect(mockRedis.requeueOutboxEvent).toHaveBeenCalledWith(testEvent);
  });
});
