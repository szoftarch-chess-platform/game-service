import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

try {
  process.loadEnvFile();
} catch {
  // Handled when environment variables are injected directly (e.g. Docker)
}

async function bootstrap() {
  const port = process.env.PORT;
  if (!port) {
    throw new Error('PORT environment variable is required');
  }

  const app = await NestFactory.create(AppModule);

  await app.listen(port);
  console.log(`Game Service is listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
