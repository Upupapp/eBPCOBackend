import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { FEE_LINES, FeeLine } from '../domain/order-of-payment';

/**
 * Publishing a fee schedule, and saying which payment methods are open.
 *
 * ── A schedule in force is never edited ─────────────────────────────────
 *
 * This is the rule the whole design rests on. Every assessment records the
 * version it was computed under so a historical bill can be explained; editing
 * that version's figures afterwards would change what the LGU is recorded as
 * having charged people who already paid. The Order in their hand would stop
 * matching the schedule it cites.
 *
 * So a change is a NEW VERSION, effective from a date, and the one it replaces
 * is closed on that date. Exactly the shape the Order of Payment already uses
 * for corrections: superseded, never amended.
 *
 * A FUTURE schedule — one whose effective date has not arrived — may still be
 * edited freely. Nothing has been assessed under it, so there is nothing to
 * contradict, and refusing would mean an LGU that mistypes a figure while
 * preparing next year's ordinance has to publish a correction to a schedule
 * nobody ever used.
 */

export interface FeeEntryInput {
  readonly permitType: string;
  readonly line: FeeLine;
  readonly amountCentavos: number;
  readonly basis: string;
}

export interface PublishedSchedule {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly publishedBy: string | null;
  readonly status: 'Superseded' | 'In force' | 'Scheduled';
  readonly entries: readonly FeeEntryInput[];
}

export type ConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export class FeeConfigService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async schedules(): Promise<readonly PublishedSchedule[]> {
    const today = isoDate(this.clock());
    const heads = await this.db.query<{
      version: string; effective_from: string; effective_to: string | null; published_by: string | null;
    }>(
      `select version, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
              to_char(effective_to, 'YYYY-MM-DD') as effective_to, published_by
         from fee_schedules order by effective_from desc`,
    );
    const entries = await this.db.query<{
      version: string; permit_type: string; line: FeeLine; amount_centavos: string; basis: string;
    }>(
      'select version, permit_type, line, amount_centavos, basis from fee_schedule_entries',
    );

    return heads.rows.map((head) => ({
      version: head.version,
      effectiveFrom: head.effective_from,
      effectiveTo: head.effective_to,
      publishedBy: head.published_by,
      // Named rather than left for a client to work out from two dates. Three
      // different clients deriving "is this the one in force" is three chances
      // to disagree with the server about which fees apply today.
      status: head.effective_to !== null && head.effective_to <= today
        ? 'Superseded'
        : head.effective_from > today ? 'Scheduled' : 'In force',
      entries: entries.rows
        .filter((entry) => entry.version === head.version)
        .map((entry) => ({
          permitType: entry.permit_type,
          line: entry.line,
          amountCentavos: Number(entry.amount_centavos),
          basis: entry.basis,
        })),
    }));
  }

  /**
   * Publishes a new version, closing whichever one it replaces.
   *
   * The replaced schedule is closed ON the new one's effective date, not today:
   * a schedule published in March to take effect in April must keep applying
   * through March, and closing it early would leave a gap in which no fee could
   * be assessed at all.
   */
  async publish(options: {
    version: string;
    effectiveFrom: string;
    publishedBy: string;
    entries: readonly FeeEntryInput[];
    officer: Caller;
  }): Promise<ConfigResult<PublishedSchedule>> {
    const { version, effectiveFrom, entries, officer } = options;
    const today = isoDate(this.clock());

    if (effectiveFrom < today) {
      // A schedule cannot begin in the past. Assessments have already been made
      // under whatever was in force, and back-dating would make them cite a
      // schedule that did not exist when they were computed.
      return {
        ok: false, reason: 'back-dated',
        detail: 'A fee schedule cannot take effect before today. Assessments have already been made '
          + 'under the schedule in force.',
      };
    }
    if (entries.length === 0) {
      return {
        ok: false, reason: 'empty',
        detail: 'A schedule with no fee lines would mean nothing can be assessed under it.',
      };
    }

    return this.db.transaction(async (tx) => {
      const clash = await tx.query('select version from fee_schedules where version = $1', [version]);
      if (clash.rows.length > 0) {
        return {
          ok: false, reason: 'version-taken',
          detail: `A schedule with version "${version}" already exists. Versions are how a historical `
            + 'assessment is explained, so they are never reused.',
        };
      }

      const known = await tx.query<{ permit_type: string }>('select permit_type from permit_types');
      const permitTypes = new Set(known.rows.map((row) => row.permit_type));
      const unknown = [...new Set(entries.map((entry) => entry.permitType))]
        .filter((permitType) => !permitTypes.has(permitType));
      if (unknown.length > 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue: ${unknown.join(', ')}.`,
        };
      }

      // Closed on the new schedule's effective date, and only if it is open
      // then. `effective_to > effective_from` is a constraint, so a schedule
      // starting the same day one began would otherwise fail on the range check
      // with a message about dates rather than about publishing.
      const current = await tx.query<{ version: string; effective_from: string }>(
        `select version, to_char(effective_from, 'YYYY-MM-DD') as effective_from
           from fee_schedules
          where effective_from < $1 and (effective_to is null or effective_to > $1)
          order by effective_from desc limit 1`,
        [effectiveFrom],
      );
      const replaced = current.rows[0] ?? null;
      if (replaced !== null) {
        await tx.query(
          'update fee_schedules set effective_to = $1 where version = $2',
          [effectiveFrom, replaced.version],
        );
      }

      await tx.query(
        'insert into fee_schedules (version, effective_from, published_by) values ($1,$2,$3)',
        [version, effectiveFrom, options.publishedBy],
      );
      for (const entry of entries) {
        await tx.query(
          `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
           values ($1,$2,$3,$4,$5)`,
          [version, entry.permitType, entry.line, entry.amountCentavos, entry.basis],
        );
      }

      await this.audit.append({
        action: 'fee-schedule.published',
        subjectType: 'order-of-payment',
        subjectId: null,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        beforeState: { replacedVersion: replaced?.version ?? null },
        afterState: {
          version, effectiveFrom, publishedBy: options.publishedBy, lineCount: entries.length,
        },
      }, tx);

      return { ok: true as const, value: null };
    }).then(async (result): Promise<ConfigResult<PublishedSchedule>> => {
      // Read AFTER the transaction commits, not inside it. `schedules()` uses
      // the outer client, and PGlite is a single connection — querying it while
      // a transaction is open on the same connection blocks until the request
      // times out. The same deadlock cost TAB 05 twenty seconds a request
      // before it was found, so it is worth saying twice: a helper that takes
      // no `tx` must not be called from inside one.
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
      const published = (await this.schedules()).find((schedule) => schedule.version === version)!;
      return { ok: true, value: published };
    });
  }

  async methods(): Promise<readonly {
    method: string; label: string; active: boolean; instructions: string;
  }[]> {
    const result = await this.db.query<{
      method: string; label: string; active: boolean; instructions: string;
    }>('select method, label, active, instructions from payment_methods order by method');
    return result.rows;
  }

  async setMethod(options: {
    method: string; officer: Caller; active?: boolean; label?: string; instructions?: string;
  }): Promise<ConfigResult<{ method: string; active: boolean }>> {
    const { method, officer } = options;

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{ active: boolean; label: string; instructions: string }>(
        'select active, label, instructions from payment_methods where method = $1 for update',
        [method],
      );
      const before = found.rows[0];
      if (before === undefined) {
        return {
          ok: false, reason: 'not-found',
          detail: `"${method}" is not a payment method this system handles. Adding one needs code, `
            + 'not configuration.',
        };
      }

      const active = options.active ?? before.active;
      if (!active) {
        const others = await tx.query<{ n: string }>(
          'select count(*) as n from payment_methods where active = true and method <> $1', [method],
        );
        if (Number(others.rows[0]?.n ?? 0) === 0) {
          // Turning off the last one leaves applicants an Order of Payment they
          // have no way to settle, and no message anywhere saying why.
          return {
            ok: false, reason: 'last-method',
            detail: 'This is the only payment method still open. Turning it off would leave applicants '
              + 'unable to pay a fee they have been assessed.',
          };
        }
      }

      await tx.query(
        `update payment_methods set active = $1, label = $2, instructions = $3,
            updated_at = $4, updated_by = $5 where method = $6`,
        [active, options.label ?? before.label, options.instructions ?? before.instructions,
         this.clock(), officer.accountId, method],
      );
      await this.audit.append({
        action: 'payment-method.changed',
        subjectType: 'payment',
        subjectId: null,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        beforeState: { method, active: before.active },
        afterState: { method, active },
      }, tx);

      return { ok: true, value: { method, active } };
    });
  }

  /** Whether a method may be used to settle a fee right now. */
  async isOpen(method: string): Promise<boolean> {
    const result = await this.db.query<{ active: boolean }>(
      'select active from payment_methods where method = $1', [method],
    );
    return result.rows[0]?.active ?? false;
  }
}

export { FEE_LINES };
