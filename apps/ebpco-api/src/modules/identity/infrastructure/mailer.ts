/**
 * Sending an email, as a port.
 *
 * Named and interfaced the same way the object store and the malware scanner
 * are (see `documents.module.ts`): the thing that changes between a laptop and
 * a real deployment is which implementation is bound, never a call site.
 */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  /** Always sent, even when `html` is also present — a client that cannot render HTML must not receive nothing. */
  readonly text: string;
  readonly html?: string;
}

export interface Mailer {
  send(message: OutboundEmail): Promise<void>;
}

export const MAILER = Symbol('EBPCO_MAILER');
