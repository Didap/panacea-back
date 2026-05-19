import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger } from 'nestjs-pino';
import { DelegationsService } from '../delegations.service';

@Injectable()
export class DelegationsCronTask {
  constructor(
    private readonly service: DelegationsService,
    private readonly logger: Logger,
  ) {}

  // Runs every day at 04:00 UTC.
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async expirePastEntries() {
    const requests = await this.service.expirePastRequests();
    const delegations = await this.service.expirePastDelegations();
    if (requests > 0 || delegations > 0) {
      this.logger.log({ requests, delegations }, 'expired pending invites and stale delegations');
    }
  }
}
