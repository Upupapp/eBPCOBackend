# ADR 0005 — Monetary columns are NUMERIC with a scale check, not BIGINT

**Status:** Accepted
**Date:** 19 August 2026

## Context

The contract's first non-negotiable is that money is integer centavos end to
end. The obvious PostgreSQL type for a centavo count is `BIGINT`, and that is
what migration 004 originally used, guarded by `CHECK (x >= 0)`.

A test was written to prove the acceptance criterion: *no monetary column
accepts a non-integer or negative value.* It failed.

## What was found

**PostgreSQL does not reject a non-integer written to a BIGINT column. It rounds
it.**

```sql
create table t (v bigint check (v >= 0));
insert into t values (50000.75);   -- succeeds
select v from t;                   -- 50001
```

The cast from `numeric` to `bigint` happens *before* the CHECK constraint runs,
so the constraint sees an already-rounded value and passes. A fee of
PHP 500.0075 silently becomes PHP 500.01, with no error anywhere.

By contrast:

```sql
create table t (v numeric check (v >= 0 and scale(v) = 0));
insert into t values (50000.75);   -- ERROR: violates check constraint
```

## Decision

Every `*_centavos` column is `NUMERIC` with `CHECK (v >= 0 and scale(v) = 0)`.

`REAL` and `DOUBLE PRECISION` remain banned everywhere in the schema, and a test
asserts no column uses them.

## Why NUMERIC does not violate "no floating point"

`NUMERIC` is arbitrary-precision **exact decimal**. It is not a floating-point
type and has none of the representation error that made floats unacceptable for
money in the first place. The rule's purpose is exactness, and `NUMERIC` is
exact; the `scale(v) = 0` check adds the integrality the rule also demands, and
adds it *loudly*.

## Consequences

- The `pg` driver returns `NUMERIC` as a string, as it does `BIGINT`. Both are
  parsed at the driver boundary by a parser that throws on a fractional value
  or one beyond the safe integer range. Left as strings they would be a live
  bug: `a + b` on two fee strings concatenates rather than adds, and produces a
  plausible number instead of an error.
- Arithmetic on `NUMERIC` is slower than on `BIGINT`, and storage is larger. At
  the volume of one LGU's permit fees this is not a consideration. If it ever
  became one, the fix is a partial index or a materialised total, not a return
  to a type that rounds fees.
- The contract is unchanged: `Centavos` remains `type: integer` on the wire.
  How the database stores it is an implementation detail, and the wire is
  already schema-validated against non-integers.
- Migration 004 was edited rather than superseded, because it had never been
  applied to any database. Once a migration has run anywhere, it is immutable
  and this would have to be a new one.

## The general lesson

A type is not a constraint. `BIGINT` expresses intent; it does not enforce it at
the boundary where bad input arrives. This was found by a test written to prove
a property rather than to confirm the code — and the property was false.
