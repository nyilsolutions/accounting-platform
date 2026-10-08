import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { PayrollModule } from '../payroll/payroll.module';
import { Form1099FilingController, PayrollEfileController } from './efile.controller';
import { EfileService } from './efile.service';
import { EFILE_TRANSMITTER, type EfileTransmitter } from './transmitters/efile-transmitter';
import { StandInTransmitter } from './transmitters/stand-in.transmitter';

export function createEfileTransmitter(config: AppConfig): EfileTransmitter | null {
  switch (config.EFILE_TRANSMITTER) {
    case 'stand-in':
      return new StandInTransmitter();
    default:
      return null;
  }
}

@Module({
  imports: [PayrollModule],
  controllers: [PayrollEfileController, Form1099FilingController],
  providers: [
    { provide: EFILE_TRANSMITTER, inject: [APP_CONFIG], useFactory: createEfileTransmitter },
    EfileService,
  ],
  exports: [EfileService, EFILE_TRANSMITTER],
})
export class EfileModule {}
