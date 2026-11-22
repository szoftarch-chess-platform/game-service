import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { AppConfigService } from '../config/config.service';

@Global()
@Module({
  providers: [AppConfigService, RedisService],
  exports: [RedisService, AppConfigService],
})
export class RedisModule {}
