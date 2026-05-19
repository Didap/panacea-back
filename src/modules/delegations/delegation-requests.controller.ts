import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DelegationsService } from './delegations.service';
import { CreateDelegationRequestDto } from './dto/create-delegation-request.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

@Controller('delegation-requests')
export class DelegationRequestsController {
  constructor(private readonly service: DelegationsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateDelegationRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { request } = await this.service.createRequest({
      actor,
      dto,
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
    return request;
  }

  @Get('mine')
  async listMine(@CurrentUser() actor: AuthenticatedUser) {
    return this.service.listMyRequests(actor);
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.cancelRequest({ actor, id, ip: ipOf(req), userAgent: req.headers['user-agent'] });
  }
}

function ipOf(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim();
  return req.ip ?? undefined;
}
