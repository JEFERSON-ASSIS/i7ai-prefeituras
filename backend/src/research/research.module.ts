import { Module } from '@nestjs/common';
import { ResearchConfigService } from './research-config.service';

@Module({
  providers: [ResearchConfigService],
  exports: [ResearchConfigService],
})
export class ResearchModule {}
