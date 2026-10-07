/**
 * pg-boss is an ES module and this API is compiled to CommonJS, so it is loaded with a dynamic
 * import (Node 22 runs it; TypeScript won't compile a static require of it).
 */
export type PgBossModule = typeof import('pg-boss', { with: { 'resolution-mode': 'import' } });
export type PgBoss = InstanceType<PgBossModule['PgBoss']>;

let loaded: Promise<PgBossModule> | null = null;
export function loadPgBoss(): Promise<PgBossModule> {
  loaded ??= import('pg-boss');
  return loaded;
}
