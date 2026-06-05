import { Body, Controller, Delete, Get, Header, HttpCode, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from './users.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getMe(user.id);
  }

  @Get('me/data-export')
  @Header('Content-Disposition', 'attachment; filename="panacea-data-export.json"')
  async exportData(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.users.exportData(user.id, { ip: ipOf(req), userAgent: req.headers['user-agent'] });
  }

  @Delete('me')
  @HttpCode(204)
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
    @Req() req: Request,
  ) {
    await this.users.deleteAccount(user.id, dto.password, {
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
