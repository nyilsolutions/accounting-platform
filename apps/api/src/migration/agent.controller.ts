import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql, type Db } from '@acct/db';
import {
  agentAttachmentQuerySchema,
  agentBatchSchema,
  agentFinishSchema,
  agentReportSchema,
  type AgentSessionDto,
} from '@acct/shared';
import { Meta, Public } from '../common/decorators';
import type { AppRequest, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { DB } from '../db/db.module';
import { AgentService, type AgentContext } from './agent.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;
type AgentRequest = AppRequest & { agent?: AgentContext };

/**
 * The Desktop agent authenticates with its pairing key (`Authorization: Bearer qbm_…`), never a
 * session. The key is looked up by its hash through a security-definer function that returns
 * only the migration it is for.
 */
@Injectable()
export class AgentKeyGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentRequest>();
    const m = /^Bearer (qbm_[A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') ?? '');
    if (!m) throw new UnauthorizedException('A pairing key is required.');
    const hash = createHash('sha256').update(m[1]!).digest('hex');
    const row = (
      await sql<{ key_id: string; company_id: string; migration_id: string; user_id: string }>`
        select * from app_migration_agent_key(${hash})`.execute(this.db)
    ).rows[0];
    if (!row)
      throw new UnauthorizedException(
        'This pairing key is not valid. Create a new one in the app.',
      );
    req.agent = {
      keyId: row.key_id,
      companyId: row.company_id,
      migrationId: row.migration_id,
      userId: row.user_id,
    };
    return true;
  }
}

const agentOf = (req: AgentRequest) => req.agent!;

/** The QuickBooks Desktop migration agent's API (ADR 0013). */
@Controller('agent/v1')
@Public()
@UseGuards(AgentKeyGuard)
export class AgentController {
  constructor(private readonly agents: AgentService) {}

  @Get('session')
  session(@Req() req: AgentRequest): Promise<AgentSessionDto> {
    return this.agents.session(agentOf(req));
  }

  @Post('batches')
  @HttpCode(200)
  batch(
    @Req() req: AgentRequest,
    @Body(new ZodPipe(agentBatchSchema)) body: Parsed<typeof agentBatchSchema>,
  ): Promise<{ received: number }> {
    return this.agents.batch(agentOf(req), body);
  }

  @Post('reports')
  @HttpCode(200)
  report(
    @Req() req: AgentRequest,
    @Body(new ZodPipe(agentReportSchema)) body: Parsed<typeof agentReportSchema>,
  ): Promise<{ rows: number }> {
    return this.agents.report(agentOf(req), body);
  }

  /** The body is the file (application/octet-stream); `path` is relative to the Attach folder. */
  @Post('attachments')
  @HttpCode(200)
  attachment(
    @Req() req: AgentRequest,
    @Query(new ZodPipe(agentAttachmentQuerySchema)) q: Parsed<typeof agentAttachmentQuerySchema>,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ): Promise<{ documentId: string | null; duplicate: boolean; refused?: string }> {
    return this.agents.attachment(agentOf(req), q.path, body, meta);
  }

  @Post('finish')
  @HttpCode(200)
  finish(
    @Req() req: AgentRequest,
    @Body(new ZodPipe(agentFinishSchema)) body: Parsed<typeof agentFinishSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ staged: number; errors: number }> {
    return this.agents.finish(agentOf(req), body, meta);
  }
}
