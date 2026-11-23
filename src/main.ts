import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';

try {
  process.loadEnvFile();
} catch {
  // Handled when environment variables are injected directly (e.g. Docker)
}

async function bootstrap() {
  // AppConfigService checks every setting when the application is created, so a missing or invalid one stops the
  // service here. Nest logs the error and exits with the code 1.
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  await app.listen(config.port, config.host);
  console.log(`Game Service is listening on ${config.host}:${config.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
