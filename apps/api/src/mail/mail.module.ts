import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { CaptureMailer, ConsoleMailer, FileMailer, MAILER } from './mailer';
import { SesMailer } from './ses-mailer';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        switch (config.MAIL_TRANSPORT) {
          case 'capture':
            return new CaptureMailer();
          case 'file':
            return new FileMailer(config.MAIL_OUTBOX_DIR);
          case 'ses':
            return new SesMailer(config.MAIL_FROM!, {
              configurationSet: config.SES_CONFIGURATION_SET,
              region: config.SES_REGION,
            });
          default:
            return new ConsoleMailer();
        }
      },
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
