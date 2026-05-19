import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DelegationsService } from './delegations.service';
import { CreateSubDelegationDto } from './dto/create-sub-delegation.dto';
import { ListDelegationsQuery } from './dto/list-delegations.query';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

@Controller('delegations')
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListDelegationsQuery,
  ) {
    return this.service.list(actor, query.as ?? 'all');
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    await this.service.revoke({
      actor,
      id,
      reason: body?.reason,
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
  }

  @Post(':parentId/sub-delegate')
  @HttpCode(201)
  async createSub(
    @Param('parentId', ParseUUIDPipe) parentId: string,
    @Body() dto: CreateSubDelegationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.createSubDelegation({
      actor,
      parentId,
      dto,
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
