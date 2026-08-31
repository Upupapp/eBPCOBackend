import { StaffAccess } from '../../identity/domain/staff-access';
import { Caller } from './application';
import { formFilterFor, formFilterSql, mayActOnPermitType } from './form-access';

const staff = (scopes: string[] = []): Caller =>
  ({ kind: 'staff', accountId: 'a', scopes, roles: [] } as unknown as Caller);
const applicant = (): Caller =>
  ({ kind: 'applicant', accountId: 'b', scopes: [], roles: [] } as unknown as Caller);

const access = (permitTypes: string[]): StaffAccess =>
  ({ level: 'view-edit', permitTypes });

describe('the filter is a row predicate, not a list to sift', () => {
  it('lets an applicant through: they read by ownership, not by allow-list', () => {
    expect(formFilterFor(applicant(), null)).toEqual({ kind: 'all' });
  });

  it('gives an unassigned officer nothing, never everything', () => {
    // The failure this table exists to prevent. Absence of a row must not be
    // read as absence of restriction.
    expect(formFilterFor(staff(), null))
      .toEqual({ kind: 'permit-types', permitTypes: [] });
  });

  it('narrows a staff caller to their assigned types', () => {
    expect(formFilterFor(staff(), access(['New Construction', 'Renovation'])))
      .toEqual({ kind: 'permit-types', permitTypes: ['New Construction', 'Renovation'] });
  });
});

describe('the SQL fragment', () => {
  it('emits `false` for an empty allow-list, not `in ()`', () => {
    // `in ()` is a syntax error in PostgreSQL. Emitting it would turn "this
    // officer reaches nothing" into a 500 — a different answer, and one that
    // tells the caller something went wrong rather than that there is nothing
    // for them.
    const { sql, params } = formFilterSql(
      { kind: 'permit-types', permitTypes: [] }, 'a.permit_type', 1);

    expect(sql).toBe('false');
    expect(params).toEqual([]);
  });

  it('emits `true` for a caller the allow-list does not govern', () => {
    expect(formFilterSql({ kind: 'all' }, 'a.permit_type', 1).sql).toBe('true');
  });

  it('parameterises the list rather than interpolating it', () => {
    // Permit types are internal keys, but they reach this from an assignment
    // table a super admin writes. Interpolating them would make an
    // authorisation filter the injection point.
    const { sql, params } = formFilterSql(
      { kind: 'permit-types', permitTypes: ["New'; drop table applications; --"] },
      'a.permit_type', 3);

    expect(sql).toBe('a.permit_type = any($3::text[])');
    expect(params).toEqual([["New'; drop table applications; --"]]);
  });
});

describe('acting is asked separately from seeing', () => {
  const table = [
    { forms: ['New Construction'], target: 'New Construction', allowed: true },
    { forms: ['New Construction'], target: 'Renovation', allowed: false },
    { forms: [], target: 'New Construction', allowed: false },
  ];

  it.each(table)('forms=$forms target=$target', ({ forms, target, allowed }) => {
    expect(mayActOnPermitType({ kind: 'permit-types', permitTypes: forms }, target))
      .toBe(allowed);
  });

  it('is exact about keys, never lenient', () => {
    // 'Fencing' and 'Fencing Permit' are different vocabularies — an internal
    // key and a published name. An authorisation decision is the last place to
    // be forgiving about which one it was handed.
    expect(mayActOnPermitType(
      { kind: 'permit-types', permitTypes: ['Fencing'] }, 'Fencing Permit')).toBe(false);
  });
});
