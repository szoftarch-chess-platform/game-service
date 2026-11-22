import { Module } from '@nestjs/common';
import { OutboxPublisher } from './outbox.publisher';
import { RedisModule } from '../redis/redis.module';
import { AppConfigService } from '../config/config.service';

@Module({
  imports: [RedisModule],
  providers: [AppConfigService, OutboxPublisher],
  exports: [OutboxPublisher],
})
export class OutboxModule {}
