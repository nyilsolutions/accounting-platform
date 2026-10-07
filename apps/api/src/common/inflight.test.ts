import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { InflightRequests } from './inflight';

const request = (t: InflightRequests) => {
  const res = Object.assign(new EventEmitter(), { end: () => res });
  t.middleware({} as never, res as never, () => undefined);
  return res;
};

describe('in-flight requests', () => {
  it('drains once every handler has answered (counted once)', async () => {
    const t = new InflightRequests();
    expect(await t.drain(10)).toBe(true);
    const a = request(t);
    const b = request(t);
    expect(t.count).toBe(2);
    const drained = t.drain(1_000);
    a.end();
    a.emit('finish');
    a.emit('close');
    expect(t.count).toBe(1);
    b.end();
    expect(await drained).toBe(true);
    expect(t.count).toBe(0);
  });

  it('keeps counting a request whose client went away until its handler answers', async () => {
    const t = new InflightRequests();
    const a = request(t);
    a.emit('close');
    expect(t.count).toBe(1);
    expect(await t.drain(20)).toBe(false);
    a.end();
    expect(t.count).toBe(0);
  });

  it('gives up after the timeout', async () => {
    const t = new InflightRequests();
    request(t);
    expect(await t.drain(20)).toBe(false);
  });
});
