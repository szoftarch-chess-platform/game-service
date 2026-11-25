import { Module } from '@nestjs/common';
import { OutboxPublisher } from './outbox.publisher';
import { RedisModule } from '../redis/redis.module';
import { AppConfigModule } from '../config/config.module';

@Module({
  imports: [RedisModule, AppConfigModule],
  providers: [OutboxPublisher],
  exports: [OutboxPublisher],
})
export class OutboxModule {}
