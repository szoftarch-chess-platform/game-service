import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { SpectateGateway } from './spectate.gateway';
import { ClockService } from '../clock/clock.service';
import { RedisModule } from '../redis/redis.module';
import { EngineModule } from '../engine/engine.module';

@Module({
  imports: [RedisModule, EngineModule],
  providers: [GameService, GameGateway, SpectateGateway, ClockService],
  exports: [GameService],
})
export class GameModule {}
