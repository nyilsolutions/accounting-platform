import {
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { Public } from '../common/decorators';
import type { AppRequest } from '../common/request';
import { ConnectionsService } from './connections.service';

/**
 * Aggregator webhooks. They carry no session or CSRF header; authenticity comes from the
 * provider's signature over the raw body (verified in the provider), and they only ever trigger a
 * download or a status change for the item they name.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly connections: ConnectionsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() req: AppRequest & { rawBody?: Buffer },
  ): Promise<{ ok: true }> {
    if (this.connections.feedConfig().provider !== provider) throw new NotFoundException();
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const ok = await this.connections.webhook(req.rawBody ?? Buffer.alloc(0), headers);
    if (!ok) throw new UnauthorizedException('Invalid webhook');
    return { ok: true };
  }
}
