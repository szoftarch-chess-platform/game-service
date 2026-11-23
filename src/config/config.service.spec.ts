import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppConfigService } from './config.service';

const settings = {
  PORT: '3001',
  HOST: '127.0.0.1',
  REDIS_URL: 'redis://game-service:redis-secret@127.0.0.1:6379',
  RABBITMQ_URL: 'amqp://game-service:rabbitmq-secret@127.0.0.1:5672/%2f',
  ENGINE_URL: 'http://127.0.0.1:8000',
};

describe('AppConfigService', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(settings)) {
      vi.stubEnv(name, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads every setting', () => {
    const config = new AppConfigService();

    expect(config.port).toBe(3001);
    expect(config.host).toBe('127.0.0.1');
    expect(config.redisUrl).toBe(settings.REDIS_URL);
    expect(config.rabbitmqUrl).toBe(settings.RABBITMQ_URL);
    expect(config.engineUrl).toBe(settings.ENGINE_URL);
  });

  it.each(Object.keys(settings))('stops without %s', (name) => {
    vi.stubEnv(name, '');

    expect(() => new AppConfigService()).toThrow(
      `The ${name} environment variable is required.`,
    );
  });

  it.each(['0', '65536', '3001.5', '3001abc'])(
    'stops with the port %s',
    (port) => {
      vi.stubEnv('PORT', port);

      expect(() => new AppConfigService()).toThrow(
        'The PORT environment variable must be a port number from 1 to 65535.',
      );
    },
  );

  it.each([
    ['REDIS_URL', 'http://127.0.0.1:6379', 'redis:// or rediss://'],
    ['RABBITMQ_URL', 'amqp//127.0.0.1:5672', 'amqp:// or amqps://'],
    ['ENGINE_URL', 'engine-service:8000', 'http:// or https://'],
  ])('stops when %s is %s', (name, value, schemes) => {
    vi.stubEnv(name, value);

    expect(() => new AppConfigService()).toThrow(
      `The ${name} environment variable must be a URL that starts with ${schemes}.`,
    );
  });

  it('keeps the password out of the error', () => {
    vi.stubEnv(
      'RABBITMQ_URL',
      'http://game-service:rabbitmq-secret@127.0.0.1:5672',
    );

    const error = catchError(() => new AppConfigService());

    expect(error.message).toContain('RABBITMQ_URL');
    expect(error.message).not.toContain('rabbitmq-secret');
  });
});

function catchError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }

  throw new Error('Expected an error.');
}
