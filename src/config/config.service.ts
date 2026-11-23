import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from './environment';

/**
 * The checked settings of the service with their types. ConfigModule checks them once at startup with
 * validateEnvironment, and the other modules read them here instead of by the names of the environment variables.
 */
@Injectable()
export class AppConfigService {
  readonly port: number;
  readonly host: string;
  readonly redisUrl: string;
  readonly rabbitmqUrl: string;
  readonly engineUrl: string;

  constructor(config: ConfigService<Environment, true>) {
    this.port = config.get('PORT', { infer: true });
    this.host = config.get('HOST', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.rabbitmqUrl = config.get('RABBITMQ_URL', { infer: true });
    this.engineUrl = config.get('ENGINE_URL', { infer: true });
  }
}
