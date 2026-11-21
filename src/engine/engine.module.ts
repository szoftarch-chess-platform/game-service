import { Module } from '@nestjs/common';
import { EngineClient } from './engine.client';
import { AppConfigService } from '../config/config.service';

@Module({
  providers: [AppConfigService, EngineClient],
  exports: [EngineClient],
})
export class EngineModule {}
