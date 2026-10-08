// The worker's first import: tracing must start before http and pg are loaded.
import { startTracing } from './tracing';

startTracing('acct-worker');
