import { Logger } from 'nestjs-pino';
import type { NotificationDriver, NotificationMessage } from './notification-driver';

export class ConsoleNotificationDriver implements NotificationDriver {
  readonly name = 'console';

  constructor(private readonly logger: Logger) {}

  send(message: NotificationMessage): Promise<void> {
    this.logger.log(
      { to: message.to, subject: message.subject },
      `[notification] ${message.subject}\n${message.text}`,
    );
    return Promise.resolve();
  }
}
