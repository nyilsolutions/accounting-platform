import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { CaptureMailer, ConsoleMailer, FileMailer, MAILER } from './mailer';

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
          default:
            return new ConsoleMailer();
        }
      },
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
