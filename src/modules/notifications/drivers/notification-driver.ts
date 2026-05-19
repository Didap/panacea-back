export type NotificationMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export interface NotificationDriver {
  readonly name: string;
  send(message: NotificationMessage): Promise<void>;
}
