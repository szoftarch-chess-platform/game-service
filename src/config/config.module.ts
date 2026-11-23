import { Module } from '@nestjs/common';
import { AppConfigService } from './config.service';

/**
 * Provides the one AppConfigService of the application. Every module that needs the settings imports this module, so
 * they all share one instance, and the settings are read and checked only once.
 */
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
