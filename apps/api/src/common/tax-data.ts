import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Reads tax tables from `/tax-data/<year>/<name>.json` (CLAUDE.md rule 7: rates and thresholds
 * live there with their citations, never in code). `TAX_DATA_DIR` overrides the location;
 * otherwise the folder is found by walking up from this file (works from src and dist).
 */
let root: string | null | undefined;

function taxDataRoot(): string | null {
  if (root !== undefined) return root;
  if (process.env.TAX_DATA_DIR) return (root = process.env.TAX_DATA_DIR);
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'tax-data');
    if (existsSync(candidate)) return (root = candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (root = null);
}

const cache = new Map<string, unknown>();

/** The parsed file, or null when there is no data for that year. */
export function loadTaxData<T>(year: number, name: string): T | null {
  const key = `${year}/${name}`;
  if (cache.has(key)) return cache.get(key) as T | null;
  const base = taxDataRoot();
  const file = base ? join(base, String(year), `${name}.json`) : null;
  const value = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
  cache.set(key, value);
  return value;
}
