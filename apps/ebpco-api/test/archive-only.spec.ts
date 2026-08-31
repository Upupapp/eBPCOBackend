import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Records are archived, never deleted.
 *
 * An application, a document, a payment and an audit entry are each evidence
 * that something happened — that a structure was authorised, that a fee was
 * paid, that an officer decided. PD 1096 and the LGU records schedule require
 * them to outlive the applicant's relationship with the LGU, and the audit
 * chain is hash-linked, so removing one row breaks every row after it.
 *
 * `POST /staff/applications/archive` exists and demands remarks. This asserts
 * nothing quietly grew a delete beside it.
 */

const SOURCE = join(__dirname, '../src');

/** Tables whose rows are evidence and are never removed. */
const PROTECTED = [
  'applications', 'application_documents', 'documents', 'payments',
  'audit_events', 'audit_chain_head', 'orders_of_payment', 'assessments',
];

/**
 * The deliberate exceptions, each with the reason it is one.
 *
 * Named here rather than pattern-matched, so adding an exception is an edit to
 * this list that a reviewer sees — not a filename that happens to slip past a
 * regular expression.
 */
const EXCEPTIONS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'identity/application/session.service.ts',
    why: 'a session is a live credential, not a record: signing out must actually revoke',
  },
  {
    file: 'identity/application/staff-directory.service.ts',
    why: 'revoking a staff session; same reason — a credential, not a record',
  },
  {
    file: 'identity/application/token.service.ts',
    why: 'refresh tokens are credentials and are rotated by deletion',
  },
  {
    file: 'notifications/application/device.service.ts',
    why: 'a device registration is a delivery address someone may withdraw',
  },
  {
    file: 'compliance/application/erasure.service.ts',
    why: 'RA 10173 gives a data subject the right to erasure; the list of what it '
      + 'may touch is cross-checked against the personal-data register, and it '
      + 'refuses staff accounts and everything statutory',
  },
  {
    file: 'identity/application/staff-access.service.ts',
    why: 'setForms replaces an allow-list: an assignment is a current permission, '
      + 'not a record of an event — the audit row carries before and after',
  },
];

/**
 * Source with COMMENTS removed — and string literals deliberately kept.
 *
 * The first version stripped strings too, which is the usual advice and is
 * exactly wrong here: this service writes short queries as single-quoted
 * strings and long ones as template literals, so blanking literals blinded the
 * scan to 11 of the 14 deletes it exists to find. The main assertion passed,
 * and passed for the wrong reason. Only the vacuity check below caught it.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) { found.push(...sourceFiles(path)); continue; }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(path);
  }
  return found;
}

describe('records are archived, never deleted', () => {
  /**
   * Templates survive comment-stripping, so the scan reads the backtick bodies
   * too — which is where every query in this service actually lives.
   */
  const deletes = (): { file: string; statement: string }[] => {
    const found: { file: string; statement: string }[] = [];
    for (const path of sourceFiles(SOURCE)) {
      const text = code(readFileSync(path, 'utf8'));
      for (const match of text.matchAll(/delete\s+from\s+([a-z_][a-z0-9_]*)/gi)) {
        found.push({ file: path.slice(SOURCE.length + 1), statement: match[1]!.toLowerCase() });
      }
    }
    return found;
  };

  it('deletes from no protected table anywhere in the service', () => {
    const allowed = new Set(EXCEPTIONS.map((exception) => exception.file));
    const offending = deletes()
      .filter((row) => PROTECTED.includes(row.statement))
      .filter((row) => !allowed.has(row.file))
      .map((row) => `${row.file}: delete from ${row.statement}`);

    expect(offending).toEqual([]);
  });

  it('finds deletes to inspect, so the scan is not vacuous', () => {
    // A scan that matches nothing passes for the wrong reason. The service does
    // delete credentials, and this asserts the reader can see them.
    // 14 at the time of writing. Asserted as a floor rather than an exact count,
    // which would fail on every unrelated credential change.
    expect(deletes().length).toBeGreaterThanOrEqual(12);
  });

  it('reads queries in BOTH literal forms this service uses', () => {
    // The regression. Stripping string literals — the usual advice for a source
    // scan — blinded this to every short query, because that is the form they
    // are written in.
    expect(code('const q = `delete from applications where id = $1`;'))
      .toContain('delete from applications');
    expect(code("await tx.query('delete from applications where id = $1');"))
      .toContain('delete from applications');
  });

  it('does not trip on a comment that mentions deleting', () => {
    // The other half. This file, and several it scans, discuss deletion at
    // length — a gate that failed against its own explanation would be noise
    // until somebody muted it.
    const stripped = code('// we never delete from applications\nconst x = 1;');

    expect(stripped).not.toContain('delete from applications');
  });

  it('states a reason for every exception', () => {
    // An exception list without reasons becomes a list of things somebody once
    // needed, and nobody can tell which are still true.
    for (const exception of EXCEPTIONS) {
      expect(exception.why.length).toBeGreaterThan(30);
    }
  });

  it('names sessions, devices and privacy erasure as the exceptions', () => {
    const reasons = EXCEPTIONS.map((exception) => exception.why).join(' ');

    expect(reasons).toContain('credential');
    expect(reasons).toContain('device registration');
    expect(reasons).toContain('RA 10173');
  });

  it('has no exception for an application, document or payment', () => {
    // The exceptions are credentials, delivery addresses and the erasure right.
    // None of them is a record of something that happened, and the moment one
    // is, this rule has been abandoned rather than amended.
    for (const exception of EXCEPTIONS) {
      expect(exception.file).not.toMatch(/applications\/application/);
      expect(exception.file).not.toMatch(/payments\/application\/payment/);
    }
  });
});
