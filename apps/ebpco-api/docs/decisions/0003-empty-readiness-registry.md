# ADR 0003 — Readiness starts with no probes

**Status:** Accepted
**Date:** 19 August 2026

## Context

The contract enumerates four readiness checks: `database`, `objectStore`,
`malwareScanner`, `pushProvider`. TAB 02 stands up the service before any of them exists;
they arrive in TABs 04, 06 and 08.

## Decision

`ReadinessService` holds a registry that starts empty. Modules register their own probe
as they are built. `/ready` therefore answers `{"status":"ready","checks":[]}` today.

## Rationale

The alternative — listing four probes now and having them report `up` against services
that do not exist — would make the first real outage invisible, and would mean the first
time anyone learned the probe was fake is during an incident.

An empty registry is the honest answer: this instance genuinely depends on nothing yet.
The answer narrows on its own as each dependency arrives, with no coordinating change.

A probe that throws is treated as `down`, never as passing. Criticality is per-probe: the
database is critical (without it every route fails, so take the instance out of rotation);
the malware scanner is not (uploads are held unscanned and everything else works, so
removing the instance would turn a partial outage into a total one).
