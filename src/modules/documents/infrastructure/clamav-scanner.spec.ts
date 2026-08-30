import { AddressInfo, Server, createServer } from 'node:net';

import { ClamAvScanner, clamAvAddress } from './clamav-scanner';
import { EICAR, LocalSignatureScanner } from '../domain/malware-scanner';
import { malwareScannerFor } from '../documents.module';
import { AppConfig } from '../../../config/app-config';

/**
 * The ClamAV client, against a real socket.
 *
 * Unlike the S3 adapter, this one's wire path IS exercised: clamd's protocol is
 * a handful of bytes, so a local TCP server can speak it faithfully. What that
 * proves is the framing -- the `zINSTREAM\0` command, the big-endian
 * length-prefixed chunk, the zero terminator -- and every branch of the reply
 * parsing, against a socket rather than a stub.
 *
 * What it does not prove is that real clamd agrees with this fake about the
 * protocol. That needs a clamd, and it is the one thing left unverified here.
 */

interface FakeClamd {
  readonly port: number;
  /** Everything the client sent, so the framing can be asserted. */
  readonly received: Buffer[];
  close(): Promise<void>;
}

async function fakeClamd(
  respond: (received: Buffer) => string | null,
): Promise<FakeClamd> {
  const received: Buffer[] = [];
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      received.push(all);

      const isPing = all.subarray(0, 6).toString('latin1') === 'zPING\0';
      // A complete INSTREAM ends with the four-byte zero terminator.
      const done = isPing
        || (all.length >= 4 && all.subarray(all.length - 4).equals(Buffer.from([0, 0, 0, 0])));
      if (!done) return;

      const reply = respond(all);
      if (reply === null) {
        // Accept and say nothing: the stalled-scanner case.
        return;
      }
      socket.write(reply);
      socket.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

describe('scanning over the wire', () => {
  it('sends INSTREAM framing clamd would accept, and reads a clean verdict', async () => {
    const clamd = await fakeClamd(() => 'stream: OK\0');
    try {
      const result = await new ClamAvScanner('127.0.0.1', clamd.port).scan(
        Buffer.from('a perfectly ordinary permit application'),
      );

      expect(result.verdict).toBe('clean');

      // The framing, asserted rather than assumed: command, big-endian length,
      // payload, zero terminator. Getting the byte order wrong here would make
      // clamd wait for a chunk that never arrives, and this client would report
      // `unavailable` forever with no other symptom.
      const sent = clamd.received[clamd.received.length - 1]!;
      expect(sent.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
      expect(sent.readUInt32BE(10)).toBe('a perfectly ordinary permit application'.length);
      expect(sent.subarray(sent.length - 4)).toEqual(Buffer.from([0, 0, 0, 0]));
    } finally {
      await clamd.close();
    }
  });

  it('reports a detection and the signature that found it', async () => {
    const clamd = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND\0');
    try {
      const result = await new ClamAvScanner('127.0.0.1', clamd.port)
        .scan(Buffer.from(EICAR, 'latin1'));

      expect(result.verdict).toBe('infected');
      expect(result.signature).toBe('Eicar-Test-Signature');
    } finally {
      await clamd.close();
    }
  });

  it('answers PING for the readiness probe', async () => {
    const clamd = await fakeClamd(() => 'PONG\0');
    try {
      expect(await new ClamAvScanner('127.0.0.1', clamd.port).isReachable()).toBe(true);
    } finally {
      await clamd.close();
    }
  });
});

describe('every failure is unavailable, and never clean', () => {
  it('when nothing is listening', async () => {
    // Port 1 on loopback: refused immediately.
    const result = await new ClamAvScanner('127.0.0.1', 1).scan(Buffer.from('x'));

    expect(result.verdict).toBe('unavailable');
  });

  it('when the scanner accepts the connection and then stalls', async () => {
    // The dangerous one. A refused connection is obvious; a scanner that takes
    // the bytes and says nothing looks like a slow scan, and answering `clean`
    // on the timeout would serve an unscanned file.
    const clamd = await fakeClamd(() => null);
    try {
      const result = await new ClamAvScanner('127.0.0.1', clamd.port, 250)
        .scan(Buffer.from('x'));

      expect(result.verdict).toBe('unavailable');
    } finally {
      await clamd.close();
    }
  });

  it('when clamd refuses the stream for being too large', async () => {
    const clamd = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR\0');
    try {
      const result = await new ClamAvScanner('127.0.0.1', clamd.port).scan(Buffer.from('x'));

      // A scan that did not happen. Reading an unrecognised reply as clean is
      // the one mistake in this client that would matter.
      expect(result.verdict).toBe('unavailable');
      expect(result.detail).toMatch(/size limit/);
    } finally {
      await clamd.close();
    }
  });

  it('when the reply is something this client has never seen', async () => {
    const clamd = await fakeClamd(() => 'stream: WAT\0');
    try {
      expect((await new ClamAvScanner('127.0.0.1', clamd.port).scan(Buffer.from('x'))).verdict)
        .toBe('unavailable');
    } finally {
      await clamd.close();
    }
  });

  it('never resolves to clean without the word OK', async () => {
    // A property rather than a case: every reply that is not an explicit OK or
    // an explicit FOUND must be unavailable, whatever it says.
    for (const reply of ['', 'stream: ', 'ERROR\0', 'stream: FOUND\0', 'okay\0']) {
      const clamd = await fakeClamd(() => (reply === '' ? null : reply));
      try {
        const result = await new ClamAvScanner('127.0.0.1', clamd.port, 250)
          .scan(Buffer.from('x'));
        expect(result.verdict).not.toBe('clean');
      } finally {
        await clamd.close();
      }
    }
  });
});

describe('reading the address out of the configured URL', () => {
  it('takes the host and port, and ignores the scheme', () => {
    // The scheme is ignored because clamd is not HTTP. The setting is written
    // as a URL because that is how this service names every other dependency.
    expect(clamAvAddress('http://scanner.internal:3310'))
      .toEqual({ host: 'scanner.internal', port: 3310 });
    expect(clamAvAddress('clamav://10.0.0.4:9000'))
      .toEqual({ host: '10.0.0.4', port: 9000 });
  });

  it('defaults to clamd’s own port when none is given', () => {
    expect(clamAvAddress('http://scanner.internal').port).toBe(3310);
  });

  it('throws rather than guessing, so a bad address fails at boot', () => {
    // At boot an operator is watching. At the first upload it would surface as
    // every document being held, with nothing saying why.
    // `scanner.internal:3310` is the likely mistake and does NOT throw inside
    // `new URL` -- it parses as the scheme `scanner.internal:` with path 3310 --
    // so the message has to name the form that works.
    expect(() => clamAvAddress('scanner.internal:3310')).toThrow(/http:\/\/host:3310/);
    expect(() => clamAvAddress('not a url at all')).toThrow(/MALWARE_SCANNER_URL/);
  });
});

describe('which scanner the service actually runs on', () => {
  // The check that was missing for the object store and found by a break-check
  // there: nothing observed which implementation the composition root built, so
  // an inline factory could name clamav and construct the stub with no test
  // disagreeing. A stub that calls every file clean is the worst thing to
  // select by accident.
  const config = (driver: 'local' | 'clamav'): AppConfig => ({
    MALWARE_SCANNER_DRIVER: driver,
    MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  } as unknown as AppConfig);

  it('builds the ClamAV client when the driver says clamav', () => {
    expect(malwareScannerFor(config('clamav'))).toBeInstanceOf(ClamAvScanner);
  });

  it('builds the local stub otherwise', () => {
    expect(malwareScannerFor(config('local'))).toBeInstanceOf(LocalSignatureScanner);
  });
});

describe('the readiness probe reports what is actually true', () => {
  /**
   * Both checks in `DocumentsModule` returned `state: 'up'` unconditionally
   * until 2026-08-30 -- placeholders that called nothing, so `/ready` said the
   * store and scanner were healthy whatever was true of them. These assert the
   * pieces those checks now call, because a probe that cannot fail is worse
   * than no probe: it is a claim.
   */
  it('reports a scanner that answers PING as reachable', async () => {
    const clamd = await fakeClamd(() => 'PONG\0');
    try {
      expect(await new ClamAvScanner('127.0.0.1', clamd.port).isReachable()).toBe(true);
    } finally {
      await clamd.close();
    }
  });

  it('reports a scanner that is not listening as unreachable', async () => {
    expect(await new ClamAvScanner('127.0.0.1', 1).isReachable()).toBe(false);
  });

  it('reports a scanner that accepts and stalls as unreachable', async () => {
    // The same shape as the scan case: silence is not health.
    const clamd = await fakeClamd(() => null);
    try {
      expect(await new ClamAvScanner('127.0.0.1', clamd.port, 250).isReachable()).toBe(false);
    } finally {
      await clamd.close();
    }
  });

  it('reports the local stub as reachable, because it runs in this process', async () => {
    // A fact about that implementation, not an assumption about scanning.
    expect(await new LocalSignatureScanner().isReachable()).toBe(true);
  });
});
