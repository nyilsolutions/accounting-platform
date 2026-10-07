// The API's first import: tracing must start before Express, http and pg are loaded.
import { startTracing } from './tracing';

startTracing('acct-api');
