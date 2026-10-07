import type { NextFunction, Request, Response } from 'express';

/**
 * Requests still being handled, so shutdown can let them finish before the database pool closes
 * (ADR 0028). Nest stops accepting connections first, but doesn't wait for running requests;
 * without this a deploy fails whatever was in flight.
 */
export class InflightRequests {
  private active = 0;
  private readonly idle = new Set<() => void>();

  get count(): number {
    return this.active;
  }

  readonly middleware = (_req: Request, res: Response, next: NextFunction): void => {
    this.active++;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.active--;
      if (this.active === 0) for (const wake of [...this.idle]) wake();
    };
    // A request is running until its handler answers. 'close' alone isn't enough: when the
    // client goes away first, the handler is still working (and using the database), and only
    // its call to res.end() says it is done.
    const resEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((...args: unknown[]) => {
      end();
      return resEnd(...args);
    }) as Response['end'];
    res.once('finish', end);
    next();
  };

  /** Resolves true once nothing is in flight, or false when `timeoutMs` passes first. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.idle.delete(wake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idle.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.idle.add(wake);
    });
  }
}

/** One per process: the API's HTTP server registers its middleware; shutdown drains it. */
export const inflightRequests = new InflightRequests();
