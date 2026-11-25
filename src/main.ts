import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';

async function bootstrap() {
  // ConfigModule checks every setting when the application is created, so a missing or invalid one stops the
  // service here. Nest logs the error and exits with the code 1.
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  // A stop signal such as SIGTERM runs onModuleDestroy of every module, which closes the connections to Redis and
  // RabbitMQ before the process ends.
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  console.log(`Game Service is listening on ${config.host}:${config.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
