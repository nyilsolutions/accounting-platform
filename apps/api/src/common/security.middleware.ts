import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './request';

export const CSRF_HEADER = 'x-csrf-protection';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Assigns a request id and echoes it back so support can correlate logs. */
export function requestIdMiddleware(req: AppRequest, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/**
 * CSRF defense for cookie-authenticated requests: state-changing requests must carry a custom
 * header (which cross-site forms cannot send and cross-origin fetches cannot send without a CORS
 * preflight we never approve), and, when present, the Origin must be our web origin.
 */
export function csrfMiddleware(allowedOrigins: string[]) {
  return (req: AppRequest, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    // Aggregator webhooks and email-in carry no cookies; they are authenticated by signature.
    // The Desktop agent sends no cookies either; it is authenticated by its pairing key.
    if (
      req.path.startsWith('/webhooks/') ||
      req.path === '/inbound/email' ||
      req.path.startsWith('/agent/v1/')
    )
      return next();
    if (req.get(CSRF_HEADER) !== '1') {
      return next(new ForbiddenException('Missing CSRF protection header'));
    }
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) {
      return next(new ForbiddenException('Cross-origin request rejected'));
    }
    next();
  };
}
