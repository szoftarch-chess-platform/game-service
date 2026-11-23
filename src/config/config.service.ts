import { Injectable } from '@nestjs/common';

/**
 * The settings of the service from its environment variables. Every setting is required, so the service reads and
 * checks them all once at startup, and a missing or invalid one stops it with an error that names the variable, as
 * the conventions of the infra repo require. The errors never contain a value, because the URLs hold passwords.
 */
@Injectable()
export class AppConfigService {
  readonly port: number;
  readonly host: string;
  readonly redisUrl: string;
  readonly rabbitmqUrl: string;
  readonly engineUrl: string;

  constructor() {
    this.port = readPort('PORT');
    // The address to listen on, 0.0.0.0 in a container and 127.0.0.1 on the host.
    this.host = readRequired('HOST');
    this.redisUrl = readUrl('REDIS_URL', ['redis:', 'rediss:']);
    this.rabbitmqUrl = readUrl('RABBITMQ_URL', ['amqp:', 'amqps:']);
    this.engineUrl = readUrl('ENGINE_URL', ['http:', 'https:']);
  }
}

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`The ${name} environment variable is required.`);
  }

  return value;
}

function readPort(name: string): number {
  const port = Number(readRequired(name));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `The ${name} environment variable must be a port number from 1 to 65535.`,
    );
  }

  return port;
}

function readUrl(name: string, protocols: string[]): string {
  const value = readRequired(name);
  const schemes = protocols.map((protocol) => `${protocol}//`).join(' or ');
  if (!URL.canParse(value) || !protocols.includes(new URL(value).protocol)) {
    throw new Error(
      `The ${name} environment variable must be a URL that starts with ${schemes}.`,
    );
  }

  return value;
}
