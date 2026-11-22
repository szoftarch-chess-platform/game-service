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

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private connection: any = null;
  private channel: any = null;
  private drainInterval: NodeJS.Timeout | null = null;
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
    }, 1500);
  }

  async onModuleDestroy() {
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
    }
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
    } catch {}
  }

  async connect(): Promise<boolean> {
    try {
      const conn = await amqp.connect(this.config.rabbitmqUrl);
      conn.on('error', (err) => {
        this.logger.warn(`RabbitMQ connection error: ${err.message}`);
      });
      conn.on('close', () => {
        this.logger.warn('RabbitMQ connection closed, scheduling reconnect...');
        this.connection = null;
        this.channel = null;
        setTimeout(() => this.connect(), 5000);
      });

      const confirmChannel = await conn.createConfirmChannel();
      confirmChannel.on('error', (err) => {
        this.logger.warn(`RabbitMQ channel error: ${err.message}`);
      });

      // Declare durable topic exchange game.events (ADR-6)
      await confirmChannel.assertExchange('game.events', 'topic', {
        durable: true,
        autoDelete: false,
      });

      this.connection = conn;
      this.channel = confirmChannel;
      this.logger.log(
        'Connected to RabbitMQ and declared exchange game.events',
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Failed to connect to RabbitMQ: ${err.message}. Retrying in 5s...`,
      );
      setTimeout(() => this.connect(), 5000);
      return false;
    }
  }

  /**
   * Drains events from the Redis outbox list and publishes them with publisher confirms.
   */
  async drainOutbox() {
    if (this.isDraining || !this.channel || Date.now() < this.nextDrainTime)
      return;
    this.isDraining = true;

    try {
      let event: GameFinishedEvent | null = null;
      while ((event = await this.redisService.popOutboxEvent())) {
        const published = await this.publishEvent(event);
        if (!published) {
          // Requeue back into Redis outbox if broker did not accept or confirm
          await this.redisService.requeueOutboxEvent(event);
          // Wait 5 seconds before retrying to prevent rapid log flooding
          this.nextDrainTime = Date.now() + 5000;
          break;
        }
      }
    } finally {
      this.isDraining = false;
    }
  }

  /**
   * Publishes a single event with mandatory flag, persistent delivery, and publisher confirm.
   */
  async publishEvent(event: GameFinishedEvent): Promise<boolean> {
    if (!this.channel) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let returned = false;

      const returnHandler = (msg: amqp.ConsumeMessage) => {
        if (msg.properties.messageId === event.id) {
          this.logger.warn(
            `Message returned by broker (unroutable, waiting for consumer queue): ${event.id}`,
          );
          returned = true;
        }
      };

      this.channel.once('return', returnHandler);

      const buffer = Buffer.from(JSON.stringify(event));
      const options: amqp.Options.Publish = {
        contentType: 'application/json',
        deliveryMode: 2, // Persistent
        mandatory: true,
        messageId: event.id,
        type: event.type,
      };

      this.channel.publish(
        'game.events',
        'game.finished',
        buffer,
        options,
        (err: any) => {
          this.channel.removeListener('return', returnHandler);

          if (err || returned) {
            const reason =
              err?.message ??
              'No consumer queue bound to game.finished (mandatory return)';
            this.logger.error(`Failed to publish event ${event.id}: ${reason}`);
            resolve(false);
          } else {
            this.logger.log(
              `Confirmed event publication to game.finished: ${event.id}`,
            );
            resolve(true);
          }
        },
      );
    });
  }
}
