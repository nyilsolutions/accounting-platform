import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { securityEvent } from '../observability/security-log';

/** The path of the first string holding a NUL character, which Postgres text can't store. */
function nulPath(value: unknown, path: Array<string | number> = []): string | null {
  if (typeof value === 'string') return value.includes('\u0000') ? path.join('.') : null;
  if (ArrayBuffer.isView(value)) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = nulPath(value[i], [...path, i]);
      if (p !== null) return p;
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = nulPath(v, [...path, k]);
      if (p !== null) return p;
    }
  }
  return null;
}

export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown) {
    const bad = nulPath(value);
    if (bad !== null) {
      securityEvent('input.rejected', { reason: 'nul', path: bad });
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: bad, message: 'Contains a character that is not allowed' }],
      });
    }
    // Express 5 leaves req.body undefined for requests without a body (e.g. a bare POST/DELETE).
    const result = this.schema.safeParse(value === undefined ? {} : value);
    if (!result.success) {
      securityEvent('input.rejected', {
        paths: [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))]
          .slice(0, 10)
          .join(','),
      });
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data as T['_output'];
  }
}
