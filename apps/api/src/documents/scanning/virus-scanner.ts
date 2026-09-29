import { connect } from 'node:net';

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; message: string };

/** Files are scanned before they can be downloaded, previewed or read. */
export interface VirusScanner {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

/** The standard antivirus test file; every scanner reports it as infected. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Development: reports only the EICAR test file, so the infected path can be exercised. */
export class DevVirusScanner implements VirusScanner {
  readonly name = 'dev';
  scan(data: Buffer): Promise<ScanResult> {
    return Promise.resolve(
      data.includes(Buffer.from(EICAR))
        ? { status: 'infected', signature: 'Eicar-Test-Signature' }
        : { status: 'clean' },
    );
  }
}

/** No scanning at all. Refused in production (see config). */
export class NoVirusScanner implements VirusScanner {
  readonly name = 'none';
  scan(): Promise<ScanResult> {
    return Promise.resolve({ status: 'clean' });
  }
}

const CHUNK = 64 * 1024;

/**
 * ClamAV's daemon over TCP with the INSTREAM command: the file is sent in length-prefixed chunks
 * ending with a zero-length chunk; clamd answers "stream: OK" or "stream: <signature> FOUND".
 */
export class ClamdVirusScanner implements VirusScanner {
  readonly name = 'clamd';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.host, port: this.port });
      const replies: Buffer[] = [];
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () =>
        done({ status: 'error', message: 'Virus scan timed out' }),
      );
      socket.on('error', (e) =>
        done({ status: 'error', message: `Virus scanner unavailable: ${e.message}` }),
      );
      socket.on('data', (d) => replies.push(d));
      socket.on('end', () => done(parseClamdReply(Buffer.concat(replies).toString('utf8'))));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(text)) return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { status: 'infected', signature: found[1]!.slice(0, 200) };
  return { status: 'error', message: `Unexpected virus scanner reply: ${text.slice(0, 200)}` };
}
