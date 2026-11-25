import { describe, it, expect } from 'vitest';
import { validateEnvironment } from './environment';

const settings = {
  PORT: '3001',
  HOST: '127.0.0.1',
  REDIS_URL: 'redis://game-service:redis-secret@127.0.0.1:6379',
  RABBITMQ_URL: 'amqp://game-service:rabbitmq-secret@127.0.0.1:5672/%2f',
  ENGINE_URL: 'http://127.0.0.1:8000',
};

describe('validateEnvironment', () => {
  it('returns every setting with its type', () => {
    expect(validateEnvironment(settings)).toEqual({
      PORT: 3001,
      HOST: '127.0.0.1',
      REDIS_URL: settings.REDIS_URL,
      RABBITMQ_URL: settings.RABBITMQ_URL,
      ENGINE_URL: settings.ENGINE_URL,
    });
  });

  it('returns only the settings of the service', () => {
    const environment = validateEnvironment({ ...settings, PATH: '/usr/bin' });

    expect(environment).not.toHaveProperty('PATH');
  });

  it.each(Object.keys(settings))('stops without %s', (name) => {
    const variables: Record<string, string> = { ...settings };
    delete variables[name];

    expect(() => validateEnvironment(variables)).toThrow(
      `The ${name} environment variable is required.`,
    );
  });

  it.each(Object.keys(settings))('stops when %s is empty', (name) => {
    expect(() => validateEnvironment({ ...settings, [name]: '' })).toThrow(
      `The ${name} environment variable is required.`,
    );
  });

  it.each([
    '0',
    '65536',
    '3001.5',
    '3001abc',
    '3001.0',
    '1e3',
    '0x0bb9',
    ' 3001',
  ])('stops with the port %s', (port) => {
    expect(() => validateEnvironment({ ...settings, PORT: port })).toThrow(
      'The PORT environment variable must be a port number from 1 to 65535.',
    );
  });

  it.each([
    ['REDIS_URL', 'http://127.0.0.1:6379', 'redis:// or rediss://'],
    ['RABBITMQ_URL', 'amqp//127.0.0.1:5672', 'amqp:// or amqps://'],
    ['ENGINE_URL', 'engine-service:8000', 'http:// or https://'],
  ])('stops when %s is %s', (name, value, schemes) => {
    expect(() => validateEnvironment({ ...settings, [name]: value })).toThrow(
      `The ${name} environment variable must be a URL that starts with ${schemes}.`,
    );
  });

  it('keeps the password out of the error', () => {
    const error = catchError(() =>
      validateEnvironment({
        ...settings,
        RABBITMQ_URL: 'http://game-service:rabbitmq-secret@127.0.0.1:5672',
      }),
    );

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
