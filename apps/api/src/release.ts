/**
 * The release step (ADR 0030): `node dist/release.js`, a one-off task of the API image run by
 * the deploy before the services roll (see `ops/release.ts`).
 */
import { runRelease } from './ops/release';

runRelease(process.env).catch((err: unknown) => {
  // The message only: never the URL or anything else from the environment.
  console.error(`release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
