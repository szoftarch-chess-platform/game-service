import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { SpectateGateway } from './spectate.gateway';

@Module({
  providers: [GameService, GameGateway, SpectateGateway],
  exports: [GameService],
})
export class GameModule {}
