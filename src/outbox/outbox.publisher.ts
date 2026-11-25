import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as amqp from 'amqplib';
import { AppConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { GameFinishedEvent } from '../domain/types';

// The exchange and the routing key of the finished games (ADR-6).
const EXCHANGE = 'game.events';
const ROUTING_KEY = 'game.finished';

// How often the outbox is drained, and how long the publisher waits before it tries the broker again.
const DRAIN_INTERVAL_MS = 1500;
export const RETRY_DELAY_MS = 5000;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private drainInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private isDraining = false;
  private nextDrainTime = 0;

  constructor(
    private readonly config: AppConfigService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    await this.connect();
    // Start interval to drain events from Redis outbox (ADR-6)
    this.drainInterval = setInterval(() => {
      this.drainOutbox().catch((err) => {
        this.logger.error(`Error draining outbox: ${err.message}`);
      });
    }, DRAIN_INTERVAL_MS);
  }

  /**
   * Stops the drain and closes the connection without connecting again. An event whose confirm has not arrived yet
   * stays in the outbox, and the next start publishes it.
   */
  async onModuleDestroy() {
    this.stopping = true;
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Closing the connection closes its channel too.
    await this.connection?.close().catch(() => {});
  }

  /**
   * Connects, opens a confirm channel and declares the exchange. If a step fails, it closes the connection that it has
   * opened, so none is left behind, and it tries again after the delay.
   */
  private async connect(): Promise<void> {
    let connection: amqp.ChannelModel | undefined;
    try {
      connection = await amqp.connect(this.config.rabbitmqUrl);
      // An error event without a listener would end the process.
      connection.on('error', (err) => {
        this.logger.warn(`RabbitMQ connection error: ${err.message}`);
      });

      const channel = await connection.createConfirmChannel();
      channel.on('error', (err) => {
        this.logger.warn(`RabbitMQ channel error: ${err.message}`);
      });

      // Declare durable topic exchange game.events (ADR-6)
      await channel.assertExchange(EXCHANGE, 'topic', {
        durable: true,
        autoDelete: false,
      });

      if (this.stopping) {
        // The service stopped while it was connecting.
        await connection.close().catch(() => {});
        return;
      }

      this.watch(connection, channel);
      this.connection = connection;
      this.channel = channel;
      this.logger.log(
        `Connected to RabbitMQ and declared exchange ${EXCHANGE}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to connect to RabbitMQ: ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000} s.`,
      );
      await connection?.close().catch(() => {});
      this.scheduleReconnect();
    }
  }

  /** Connects again after the connection or the channel closes. */
  private watch(connection: amqp.ChannelModel, channel: amqp.ConfirmChannel) {
    channel.once('close', () => {
      // The broker closes a channel after an error, such as a deleted exchange, while the connection stays open, and
      // a closed channel cannot be used again, so the connection is closed too. A closing connection closes its
      // channels first, so the check waits until the close of the connection has been handled.
      queueMicrotask(() => {
        if (this.connection === connection && !this.stopping) {
          connection.close().catch(() => {});
        }
      });
    });

    connection.once('close', () => {
      this.connection = null;
      this.channel = null;
      if (!this.stopping) {
        this.logger.warn(
          `RabbitMQ connection closed. Connecting again in ${RETRY_DELAY_MS / 1000} s.`,
        );
        this.scheduleReconnect();
      }
    });
  }

  /** Connects again after the delay, unless a new connection is due already or the service stops. */
  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RETRY_DELAY_MS);
  }

  /**
   * Publishes the events of the outbox from the oldest one with publisher confirms. An event leaves the outbox only
   * after the broker has confirmed it, so a crash or a refused event loses nothing (ADR-6). A crash between the
   * confirm and the removal publishes the event again, and the consumer filters out the repeated one.
   */
  async drainOutbox() {
    if (this.isDraining || !this.channel || Date.now() < this.nextDrainTime)
      return;
    this.isDraining = true;

    try {
      await this.publishOldestEvents();
    } finally {
      this.isDraining = false;
    }
  }

  /** Publishes the oldest event and then the next ones, until the outbox is empty or the broker refuses one. */
  private async publishOldestEvents(): Promise<void> {
    const entry = await this.redisService.peekOutboxEvent();
    if (!entry) {
      return;
    }

    if (!(await this.publishEvent(entry.event))) {
      // The event stays in the outbox, and the next drain tries it again after the delay.
      this.nextDrainTime = Date.now() + RETRY_DELAY_MS;
      return;
    }

    await this.redisService.removeOutboxEvent(entry.json);
    return this.publishOldestEvents();
  }

  /**
   * Publishes a single event with mandatory flag, persistent delivery, and publisher confirm. It returns true only
   * when the broker has confirmed the event without returning it.
   */
  async publishEvent(event: GameFinishedEvent): Promise<boolean> {
    // The connection may close while the event waits for its confirm, which empties this.channel.
    const channel = this.channel;
    if (!channel) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let returned = false;

      // The broker returns an unroutable event before it confirms it. The handler stays until the confirm, so the
      // return of another event cannot use it up.
      const returnHandler = (msg: amqp.Message) => {
        if (msg.properties.messageId === event.id) {
          this.logger.warn(
            `The broker returned the event ${event.id}, because no queue is bound to ${ROUTING_KEY} yet.`,
          );
          returned = true;
        }
      };

      channel.on('return', returnHandler);

      const buffer = Buffer.from(JSON.stringify(event));
      const options: amqp.Options.Publish = {
        contentType: 'application/json',
        deliveryMode: 2, // Persistent
        mandatory: true,
        messageId: event.id,
        type: event.type,
      };

      const onConfirm = (err: any) => {
        channel.removeListener('return', returnHandler);

        if (err || returned) {
          const reason = err?.message ?? `no queue is bound to ${ROUTING_KEY}`;
          this.logger.error(`Failed to publish event ${event.id}: ${reason}`);
          resolve(false);
        } else {
          this.logger.log(
            `Confirmed event publication to ${ROUTING_KEY}: ${event.id}`,
          );
          resolve(true);
        }
      };

      try {
        channel.publish(EXCHANGE, ROUTING_KEY, buffer, options, onConfirm);
      } catch (err) {
        // A closed channel throws at once and never calls back.
        onConfirm(err);
      }
    });
  }
}
