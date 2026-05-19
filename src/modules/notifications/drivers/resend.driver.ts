import type { NotificationDriver, NotificationMessage } from './notification-driver';

export class ResendNotificationDriver implements NotificationDriver {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(_message: NotificationMessage): Promise<void> {
    void this.apiKey;
    void this.from;
    throw new Error('ResendNotificationDriver not yet implemented; switch NOTIFICATIONS_DRIVER=console for dev');
  }
}
