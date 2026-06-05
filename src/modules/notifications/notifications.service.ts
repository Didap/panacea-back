import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import type { NotificationDriver, NotificationMessage } from './drivers/notification-driver';

export const NOTIFICATION_DRIVER = Symbol('NOTIFICATION_DRIVER');

export type InvitationEmailContext = {
  to: string;
  requesterName: string;
  invitationUrl: string;
  expiresAt: Date;
  reason?: string | null;
  requestCanSubDelegate: boolean;
};

export type OtpEmailContext = {
  to: string;
  code: string;
  expiresAt: Date;
};

export type DelegationCreatedContext = {
  to: string;
  delegateName: string;
  delegatorName: string;
  expiresAt: Date | null;
};

export type SubDelegationCreatedContext = {
  to: string;
  parentDelegateName: string;
  childDelegateName: string;
  patientName: string;
  revokeUrl: string;
};

export type DelegationRevokedContext = {
  to: string;
  delegatorName: string;
  delegateName: string;
};

@Injectable()
export class NotificationsService {
  private readonly publicBaseUrl: string;

  constructor(
    @Inject(NOTIFICATION_DRIVER) private readonly driver: NotificationDriver,
    config: ConfigService<Env, true>,
  ) {
    this.publicBaseUrl = config.get('PUBLIC_WEB_BASE_URL', { infer: true });
  }

  invitationUrl(rawToken: string): string {
    return `${this.publicBaseUrl}/inviti/${rawToken}`;
  }

  async sendInvitationEmail(ctx: InvitationEmailContext): Promise<void> {
    const subDelegateNote = ctx.requestCanSubDelegate
      ? '\nIl richiedente potra estendere l\'accesso ad altri medici.\n'
      : '';
    const reasonNote = ctx.reason ? `\nMotivazione: ${ctx.reason}\n` : '';
    const text = [
      `${ctx.requesterName} ti ha invitato a condividere la tua cartella clinica su Panacea.`,
      '',
      `Apri questo link per controllare la richiesta e accettare o rifiutare:`,
      ctx.invitationUrl,
      '',
      `L'invito scade il ${ctx.expiresAt.toISOString()}.`,
      reasonNote,
      subDelegateNote,
      'Se non riconosci questa richiesta, ignora questa email. Nessun accesso e\' stato concesso.',
    ].join('\n');
    await this.send({ to: ctx.to, subject: 'Richiesta di delega su Panacea', text });
  }

  async sendOtpEmail(ctx: OtpEmailContext): Promise<void> {
    const text = [
      'Il tuo codice di conferma Panacea e\':',
      '',
      `    ${ctx.code}`,
      '',
      `Scade il ${ctx.expiresAt.toISOString()}.`,
      'Non condividerlo con nessuno. Panacea non ti chiedera\' mai questo codice per telefono.',
    ].join('\n');
    await this.send({ to: ctx.to, subject: 'Codice di conferma Panacea', text });
  }

  async sendDelegationCreatedEmail(ctx: DelegationCreatedContext): Promise<void> {
    const expires = ctx.expiresAt
      ? `Scade il ${ctx.expiresAt.toISOString()}.`
      : 'La delega resta attiva finche\' non la revochi.';
    const text = [
      `Hai concesso a ${ctx.delegateName} l'accesso alla tua cartella clinica su Panacea.`,
      '',
      expires,
      '',
      'Puoi revocare la delega in qualsiasi momento dalla sezione "Le mie deleghe".',
    ].join('\n');
    await this.send({ to: ctx.to, subject: 'Delega concessa su Panacea', text });
  }

  async sendSubDelegationCreatedEmail(ctx: SubDelegationCreatedContext): Promise<void> {
    const text = [
      `${ctx.parentDelegateName} ha esteso l'accesso alla tua cartella clinica al collega ${ctx.childDelegateName}.`,
      '',
      `Hai dato il consenso preventivo al momento della delega originale.`,
      'Se non vuoi piu\' che il collega abbia accesso, revocala subito:',
      ctx.revokeUrl,
    ].join('\n');
    await this.send({ to: ctx.to, subject: 'Estensione di delega su Panacea', text });
  }

  async sendDelegationRevokedEmail(ctx: DelegationRevokedContext): Promise<void> {
    const text = [
      `La delega tra ${ctx.delegatorName} e ${ctx.delegateName} su Panacea e' stata revocata.`,
      '',
      'L\'accesso e\' stato chiuso immediatamente. Nessuna nuova azione puo\' essere compiuta sotto questa delega.',
    ].join('\n');
    await this.send({ to: ctx.to, subject: 'Delega revocata su Panacea', text });
  }

  private async send(message: NotificationMessage): Promise<void> {
    await this.driver.send(message);
  }
}
