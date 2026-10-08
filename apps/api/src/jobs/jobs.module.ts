import { Global, Module } from '@nestjs/common';
import { JobQueue } from './job-queue.service';

/** The job queue (ADR 0027), available everywhere so services can send and register jobs. */
@Global()
@Module({
  providers: [JobQueue],
  exports: [JobQueue],
})
export class JobsModule {}
