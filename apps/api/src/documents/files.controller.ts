import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { InboundEmailResultDto } from '@acct/shared';
import { Meta, Public } from '../common/decorators';
import type { RequestMeta } from '../common/request';
import { DocumentsService } from './documents.service';
import { InboundEmailService } from './inbound-email.service';

/** Routes without a session: signed download links, and email-in from the mail provider. */
@Controller()
export class FilesController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly inbound: InboundEmailService,
  ) {}

  /**
   * The token was issued after a permission check and expires in minutes. A trailing file name
   * is ignored; it only gives the browser's PDF viewer and downloads a readable title.
   */
  @Public()
  @Get(['files/:token', 'files/:token/:name'])
  async file(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const { data, headers } = await this.documents.serve(token);
    res.set(headers).status(200).end(data);
  }

  @Public()
  @Post('inbound/email')
  @HttpCode(200)
  receive(
    @Body() body: unknown,
    @Headers('x-inbound-signature') signature: string | undefined,
    @Meta() meta: RequestMeta,
  ): Promise<InboundEmailResultDto> {
    if (!this.inbound.enabled) throw new NotFoundException();
    if (!Buffer.isBuffer(body)) throw new NotFoundException();
    return this.inbound.receive(body, signature, meta);
  }
}
