import {
  Controller,
  Get,
  Post,
  Param,
  NotImplementedException,
} from '@nestjs/common';
import { GameService } from './game.service';

@Controller('games')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'game-service' };
  }

  @Get()
  findAll() {
    // TODO: Query active games
    throw new NotImplementedException('Getting games is not yet implemented');
  }

  @Post()
  createGame() {
    // TODO: Initialize new game session
    throw new NotImplementedException('Creating a game is not yet implemented');
  }

  @Get(':id')
  getGameById(@Param('id') id: string) {
    // TODO: Fetch state for game by ID
    throw new NotImplementedException(`Getting game ${id} is not yet implemented`);
  }
}
