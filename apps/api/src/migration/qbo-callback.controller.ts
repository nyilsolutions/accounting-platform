import { Controller, Get, Query, Redirect } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { CurrentAuth, Meta } from '../common/decorators';
import type { AuthContext, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { describeError } from './migration-common';
import { QboService } from './qbo.service';

const callbackSchema = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(2000).optional(),
  realmId: z.string().max(40).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Intuit's OAuth redirect (QBO_REDIRECT_URI → /api/migration/qbo/callback). It needs the signed-in
 * session; the signed `state` ties it to the user, company and migration that started it.
 */
@Controller('migration/qbo')
export class QboCallbackController {
  constructor(
    private readonly qbo: QboService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('callback')
  @Redirect()
  async callback(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodPipe(callbackSchema)) q: z.output<typeof callbackSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string }> {
    try {
      return { url: `${this.config.WEB_ORIGIN}${await this.qbo.callback(a, q, meta)}` };
    } catch (e) {
      const message = encodeURIComponent(describeError(e).slice(0, 300));
      return { url: `${this.config.WEB_ORIGIN}/?qboError=${message}` };
    }
  }
}
