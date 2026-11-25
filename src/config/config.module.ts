import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './config.service';
import { validateEnvironment } from './environment';

/**
 * Provides the one AppConfigService of the application. Every module that needs the settings imports this module, so
 * they all share one instance, and the settings are read and checked only once.
 *
 * ConfigModule reads the environment and the files .env.local and .env when they exist. The environment wins, so in
 * a container compose sets every setting. On the host the setup script of the infra repo writes .env, and .env.local
 * holds the values of the developer, so it wins over .env.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
      validate: validateEnvironment,
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
