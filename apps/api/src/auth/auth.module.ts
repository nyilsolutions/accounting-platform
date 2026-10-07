import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BREACH_CHECKER, HibpBreachChecker, NoBreachCheck } from './breach-check';
import { RecentMfaGuard } from './recent-mfa.guard';
import { CredentialCleanupService } from './credential-cleanup.service';
import { SecurityNoticesService } from './security-notices.service';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    SecurityNoticesService,
    CredentialCleanupService,
    RecentMfaGuard,
    {
      provide: BREACH_CHECKER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.PASSWORD_BREACH_CHECK === 'hibp' ? new HibpBreachChecker() : new NoBreachCheck(),
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [SessionService, SecurityNoticesService, RecentMfaGuard],
})
export class AuthModule {}
