import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DelegationsService } from './delegations.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { AcceptAndSignupDto } from './dto/accept-and-signup.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

@Controller('inviti')
export class InvitationsController {
  constructor(private readonly service: DelegationsService) {}

  @Public()
  @Get(':token')
  async lookup(@Param('token') token: string) {
    return this.service.lookupByToken(token);
  }

  @Public()
  @Post(':token/otp')
  @HttpCode(202)
  async requestOtp(@Param('token') token: string, @Req() req: Request) {
    await this.service.generateInvitationOtp(token, {
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
    return { status: 'sent' };
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.acceptInvitation(
      token,
      { otp: dto.otp, canSubDelegateOverride: dto.canSubDelegate },
      actor,
      { ip: ipOf(req), userAgent: req.headers['user-agent'] },
    );
  }

  @Public()
  @Post(':token/accept-and-signup')
  async acceptAndSignup(
    @Param('token') token: string,
    @Body() dto: AcceptAndSignupDto,
    @Req() req: Request,
  ) {
    return this.service.acceptAndSignup(token, dto, {
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post(':token/reject')
  @HttpCode(204)
  async reject(@Param('token') token: string, @Req() req: Request) {
    await this.service.rejectInvitation(token, {
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
  }
}

function ipOf(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim();
  return req.ip ?? undefined;
}
