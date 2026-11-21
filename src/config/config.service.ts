import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  get port(): number {
    return parseInt(process.env.PORT || '3001', 10);
  }

  get host(): string {
    return process.env.HOST || '127.0.0.1';
  }

  get redisUrl(): string {
    return process.env.REDIS_URL || 'redis://localhost:6379';
  }

  get rabbitmqUrl(): string {
    return process.env.RABBITMQ_URL || 'amqp://localhost:5672/%2f';
  }

  get engineUrl(): string {
    return process.env.ENGINE_URL || 'http://localhost:8000';
  }
}
