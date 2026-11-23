import { Module } from '@nestjs/common';
import { EngineClient } from './engine.client';
import { AppConfigModule } from '../config/config.module';

@Module({
  imports: [AppConfigModule],
  providers: [EngineClient],
  exports: [EngineClient],
})
export class EngineModule {}
