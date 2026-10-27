import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CentralConversationsController } from './central-conversations.controller';
import { CentralConversationsService } from './central-conversations.service';

@Module({ imports: [AuthModule], controllers: [CentralConversationsController], providers: [CentralConversationsService] })
export class CentralModule {}
