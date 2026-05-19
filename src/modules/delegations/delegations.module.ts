import { Module } from '@nestjs/common';
import { DelegationsService } from './delegations.service';
import { DelegationsController } from './delegations.controller';
import { DelegationRequestsController } from './delegation-requests.controller';
import { InvitationsController } from './invitations.controller';
import { DelegationsCronTask } from './tasks/delegations-cron.task';

@Module({
  controllers: [
    DelegationsController,
    DelegationRequestsController,
    InvitationsController,
  ],
  providers: [DelegationsService, DelegationsCronTask],
  exports: [DelegationsService],
})
export class DelegationsModule {}
