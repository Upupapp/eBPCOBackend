import { Socket } from 'node:net';

import { MalwareScanner, ScanResult } from '../domain/malware-scanner';

/**
 * ClamAV, over clamd's INSTREAM protocol.
 *
 * ── clamd is not HTTP, and the setting looks like it is ─────────────────
 *
 * `MALWARE_SCANNER_URL` is written as `http://scanner.internal:3310` because a
 * URL is how the rest of this service names a dependency. clamd speaks its own
 * line protocol on a TCP socket; 3310 is its default port. **The scheme is
 * parsed and ignored**, and that is worth saying out loud, because the next
 * person to read the setting will reasonably assume an HTTP client and wonder
 * why there is a socket here.
 *
 * ── Why INSTREAM and not SCAN ───────────────────────────────────────────
 *
 * `SCAN /path` requires clamd to see the same filesystem as this process. In a
 * container, and with documents going to object storage, it does not. INSTREAM
 * sends the bytes over the connection, which works wherever clamd runs.
 *
 * ── `unavailable` is never `clean` ──────────────────────────────────────
 *
 * Every failure here -- refused connection, timeout, a reply this does not
 * understand -- answers `unavailable`. The port's own words: a scanner that is
 * down must not result in a file being served unscanned, and must not result in
 * the upload being rejected either. The applicant did nothing wrong. The file
 * is accepted and held. Answering `clean` on a timeout would be the one bug in
 * this file that matters, so nothing here can throw its way to that answer.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(
    private readonly host: string,
    private readonly port: number,
    /**
     * Bounds the whole exchange, not each read. A scanner that accepts the
     * connection and then stalls would otherwise hold a request open until the
     * service's own request timeout, turning one slow upload into a held
     * connection from a pool that other applicants are waiting on.
     */
    private readonly timeoutMs: number = 10_000,
  ) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return this.exchange((socket) => {
      socket.write('zINSTREAM\0');
      // Length-prefixed chunks, big-endian, terminated by a zero length. Sent
      // in one write rather than streamed: permit attachments are bounded by
      // BODY_LIMIT_BYTES, well under clamd's StreamMaxLength.
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length, 0);
      socket.write(length);
      socket.write(bytes);
      socket.write(Buffer.from([0, 0, 0, 0]));
    }).then((reply) => this.verdictFrom(reply));
  }

  /** Whether clamd answers at all. Used by the readiness probe. */
  async isReachable(): Promise<boolean> {
    const reply = await this.exchange((socket) => { socket.write('zPING\0'); });
    return reply !== null && reply.includes('PONG');
  }

  private verdictFrom(reply: string | null): ScanResult {
    const scannedAt = new Date();
    if (reply === null) {
      return { verdict: 'unavailable', detail: 'clamd did not answer', scannedAt };
    }

    // `stream: OK`, `stream: Eicar-Test-Signature FOUND`, or an ERROR line.
    if (/\bOK\b/.test(reply) && !/FOUND/.test(reply)) return { verdict: 'clean', scannedAt };

    const found = /:\s*(.+?)\s+FOUND/.exec(reply);
    if (found !== null) {
      // An unnamed detection is still a detection. The signature is for the
      // security event; its absence must never downgrade the verdict.
      const signature = found[1];
      return signature === undefined
        ? { verdict: 'infected', scannedAt }
        : { verdict: 'infected', signature, scannedAt };
    }

    // Anything else -- including `INSTREAM size limit exceeded` -- is a scan
    // that did not happen. Reading an unrecognised reply as clean is exactly
    // the mistake this class exists not to make.
    return {
      verdict: 'unavailable',
      detail: `clamd replied with something this client does not understand: ${reply.trim()}`,
      scannedAt,
    };
  }

  /**
   * One request, one reply, one socket.
   *
   * Resolves with `null` on every failure rather than rejecting, so no caller
   * can turn a scanner outage into an exception that some `catch` further up
   * treats as a clean file.
   */
  private exchange(send: (socket: Socket) => void): Promise<string | null> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let reply = '';
      let settled = false;

      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => { finish(null); });
      socket.on('error', () => { finish(null); });
      socket.on('data', (chunk: Buffer) => { reply += chunk.toString('utf8'); });
      // clamd closes the connection after replying to a `z`-prefixed command.
      socket.on('close', () => { finish(reply.length > 0 ? reply : null); });

      socket.connect(this.port, this.host, () => {
        try {
          send(socket);
        } catch {
          finish(null);
        }
      });
    });
  }
}

/**
 * Reads host and port out of the configured URL.
 *
 * Throws rather than guessing. A scanner address that cannot be parsed is a
 * configuration error, and it belongs at boot -- where an operator is watching
 * -- rather than at the first upload, where it would surface as every document
 * being held.
 */
export function clamAvAddress(url: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `MALWARE_SCANNER_URL is not a URL: "${url}". clamd is not HTTP, but the address is `
      + 'written as one — http://host:3310 — and the scheme is ignored.',
    );
  }

  const port = parsed.port.length > 0 ? Number(parsed.port) : 3310;
  if (parsed.hostname.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    // The likely mistake, named. `scanner.internal:3310` does not throw in
    // `new URL` -- it parses as the scheme `scanner.internal:` with the path
    // `3310` -- so without this an operator gets "no host" for an address that
    // looks entirely reasonable to them.
    throw new Error(
      `MALWARE_SCANNER_URL is not a URL naming a host and port: "${url}". `
      + 'Write it as http://host:3310 — clamd is not HTTP, and the scheme is ignored.',
    );
  }
  return { host: parsed.hostname, port };
}
