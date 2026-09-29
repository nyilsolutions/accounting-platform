import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClamdVirusScanner, DevVirusScanner, EICAR, parseClamdReply } from './virus-scanner';

/** A fake clamd: reads INSTREAM chunks and answers like the real daemon. */
function fakeClamd(): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = Buffer.from('zINSTREAM\0');
      if (!buf.subarray(0, cmd.length).equals(cmd)) return;
      let pos = cmd.length;
      const chunks: Buffer[] = [];
      while (pos + 4 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        if (len === 0) {
          const file = Buffer.concat(chunks);
          received.push(file);
          socket.end(
            file.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0',
          );
          return;
        }
        if (pos + 4 + len > buf.length) return;
        chunks.push(buf.subarray(pos + 4, pos + 4 + len));
        pos += 4 + len;
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, received });
    }),
  );
}

describe('ClamdVirusScanner', () => {
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  beforeAll(async () => {
    clamd = await fakeClamd();
  });
  afterAll(() => new Promise<void>((r) => clamd.server.close(() => r())));

  it('streams the whole file in chunks and reads the verdict', async () => {
    const scanner = new ClamdVirusScanner('127.0.0.1', clamd.port);
    const big = Buffer.alloc(200 * 1024, 7);
    expect(await scanner.scan(big)).toEqual({ status: 'clean' });
    expect(clamd.received.at(-1)).toEqual(big);
    expect(await scanner.scan(Buffer.from(`hello ${EICAR}`))).toEqual({
      status: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('reports an unreachable daemon as an error, not clean', async () => {
    const scanner = new ClamdVirusScanner('127.0.0.1', 1, 2000);
    const r = await scanner.scan(Buffer.from('x'));
    expect(r.status).toBe('error');
  });
});

describe('scanner replies', () => {
  it('parses clamd answers', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR').status).toBe('error');
  });

  it('flags EICAR in development', async () => {
    const dev = new DevVirusScanner();
    expect((await dev.scan(Buffer.from(EICAR))).status).toBe('infected');
    expect((await dev.scan(Buffer.from('%PDF'))).status).toBe('clean');
  });
});
