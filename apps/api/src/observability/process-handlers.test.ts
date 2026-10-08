import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessHandlers } from './process-handlers';

describe('process handlers', () => {
  const before = {
    rejection: process.listeners('unhandledRejection'),
    exception: process.listeners('uncaughtException'),
  };
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    for (const l of before.rejection) process.on('unhandledRejection', l);
    for (const l of before.exception) process.on('uncaughtException', l);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('logs an unhandled rejection and keeps running; exits after an uncaught exception', () => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessHandlers('Process');

    const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
    emit('unhandledRejection', new Error('lost promise'), Promise.resolve());
    expect(errors[0]).toContain('Unhandled promise rejection: Error: lost promise');
    expect(process.exitCode).toBeUndefined();

    emit('uncaughtException', new Error('broken state'), 'uncaughtException');
    expect(errors[1]).toContain('Uncaught exception, exiting');
    expect(process.exitCode).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
