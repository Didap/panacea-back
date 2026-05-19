import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { NOTIFICATION_DRIVER, NotificationsService } from './notifications.service';
import { ConsoleNotificationDriver } from './drivers/console.driver';
import { ResendNotificationDriver } from './drivers/resend.driver';
import type { Env } from '../../config/env';
import type { NotificationDriver } from './drivers/notification-driver';

@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATION_DRIVER,
      inject: [ConfigService, Logger],
      useFactory: (
        config: ConfigService<Env, true>,
        logger: Logger,
      ): NotificationDriver => {
        const driver = config.get('NOTIFICATIONS_DRIVER', { infer: true });
        if (driver === 'resend') {
          const apiKey = config.get('RESEND_API_KEY', { infer: true });
          const from = config.get('NOTIFICATIONS_FROM', { infer: true });
          if (!apiKey || !from) {
            throw new Error(
              'NOTIFICATIONS_DRIVER=resend requires RESEND_API_KEY and NOTIFICATIONS_FROM',
            );
          }
          return new ResendNotificationDriver(apiKey, from);
        }
        return new ConsoleNotificationDriver(logger);
      },
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
