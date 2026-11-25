import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './config.service';
import { Environment } from './environment';

describe('AppConfigService', () => {
  it('reads every setting from ConfigService', () => {
    const environment: Environment = {
      PORT: 3001,
      HOST: '127.0.0.1',
      REDIS_URL: 'redis://game-service:redis-secret@127.0.0.1:6379',
      RABBITMQ_URL: 'amqp://game-service:rabbitmq-secret@127.0.0.1:5672/%2f',
      ENGINE_URL: 'http://127.0.0.1:8000',
    };
    const configService = {
      get: (name: keyof Environment) => environment[name],
    } as ConfigService<Environment, true>;

    const config = new AppConfigService(configService);

    expect(config.port).toBe(3001);
    expect(config.host).toBe(environment.HOST);
    expect(config.redisUrl).toBe(environment.REDIS_URL);
    expect(config.rabbitmqUrl).toBe(environment.RABBITMQ_URL);
    expect(config.engineUrl).toBe(environment.ENGINE_URL);
  });
});
