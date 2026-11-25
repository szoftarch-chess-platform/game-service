import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GameModule } from './game/game.module';
import { RedisModule } from './redis/redis.module';
import { EngineModule } from './engine/engine.module';
import { OutboxModule } from './outbox/outbox.module';

@Module({
  imports: [RedisModule, EngineModule, OutboxModule, GameModule],
  controllers: [HealthController],
})
export class AppModule {}
