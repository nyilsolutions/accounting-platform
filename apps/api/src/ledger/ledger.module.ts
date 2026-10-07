import { Global, Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { LedgerController } from './ledger.controller';
import { LedgerSettingsService } from './ledger-settings.service';
import { LedgerSetupService } from './ledger-setup.service';
import { ClosingPasswordAttempts } from './closing-password-attempts';
import { PostingService } from './posting.service';

@Global()
@Module({
  controllers: [LedgerController],
  providers: [
    AccountsService,
    JournalService,
    LedgerSettingsService,
    LedgerSetupService,
    PostingService,
    ClosingPasswordAttempts,
  ],
  exports: [
    AccountsService,
    JournalService,
    LedgerSetupService,
    LedgerSettingsService,
    PostingService,
    ClosingPasswordAttempts,
  ],
})
export class LedgerModule {}
