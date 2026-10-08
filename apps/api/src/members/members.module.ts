import { Module } from '@nestjs/common';
import { InvitationsController, MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [MembersController, InvitationsController],
  providers: [MembersService],
})
export class MembersModule {}
