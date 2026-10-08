import { Controller, Get, Inject } from '@nestjs/common';
import { sql, type Db } from '@acct/db';
import { Public } from '../common/decorators';
import { DB } from '../db/db.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get()
  async health(): Promise<{ status: 'ok'; db: 'ok' }> {
    await sql`select 1`.execute(this.db);
    return { status: 'ok', db: 'ok' };
  }
}
