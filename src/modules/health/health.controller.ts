import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.admin().execute(sql`SELECT 1`);
      return { status: 'ok', db: 'up' };
    } catch {
      return { status: 'degraded', db: 'down' };
    }
  }
}
