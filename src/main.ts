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

  // The address to listen on, 0.0.0.0 in a container and 127.0.0.1 on the host.
  const host = process.env.HOST;
  if (!host) {
    throw new Error('HOST environment variable is required');
  }

  const app = await NestFactory.create(AppModule);

  await app.listen(port, host);
  console.log(`Game Service is listening on ${host}:${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
