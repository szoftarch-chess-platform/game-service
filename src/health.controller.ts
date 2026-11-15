import { Controller, Get } from '@nestjs/common';

// The only HTTP endpoint of the service. The health check of the container calls it,
// and the API gateway has no route to it.
@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return { status: 'ok', service: 'game-service' };
  }
}
