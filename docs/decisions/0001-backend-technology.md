# ADR 0001 — Backend technology: NestJS on Node/TypeScript

**Status:** Accepted (locally reversible until first deployment)
**Date:** 19 August 2026
**Decides:** Master Command decision **E-1**, first half. The hosting half remains open.

## Context

The Production Launch Master Command names E-1 — backend technology and hosting — as an
owner decision, and recommends NestJS on Node/TypeScript, or Spring Boot where the LGU's
IT unit is Java-shopped. The supervisor protocol authorises me to decide this
autonomously and document the rationale, so this record is the decision.

## Options considered

| Option | For | Against |
|---|---|---|
| **NestJS / Node / TypeScript** | Shares a language with the Angular admin, so the admin's `core/domain/*.model.ts` — which TAB 01 established as the vocabulary of record — can become a shared package rather than being retyped. Dependency injection and module boundaries are native, which is how "lifecycle rules never live in controllers" becomes structural rather than a review habit. Buildable and testable on this machine today, which matters for evidence-backed completion. | Node's single-threaded model needs care under CPU-bound work; none of this service's work is CPU-bound. |
| **Spring Boot / Java** | Strong typing, mature government adoption, excellent transaction handling. | A second language across the estate. The admin's domain types would have to be retyped in Java — precisely the drift TAB 01 exists to prevent. |
| **Go** | Small deployable, excellent concurrency. | No shared vocabulary with either client. Fewest matching skills in a typical LGU IT unit. |
| **Laravel / PHP** | Widely staffed. | A third language, and the weakest fit with a contract-first, schema-validated design. |

## Decision

**NestJS 11 on Node 22/24, TypeScript, with the Fastify adapter.**

The deciding argument is not performance, it is drift. TAB 01's entire purpose was to
stop the admin and mobile describing one permit differently. Choosing a backend language
the admin does not speak would guarantee a third hand-maintained copy of the same
nineteen statuses and seventeen permit types, in Java or Go, within a month. Sharing
TypeScript with the admin means those types can be generated once and imported.

**Fastify over the default Express adapter**, and this one *is* a safety argument rather
than a benchmark: Fastify serialises responses from schemas, so a field absent from a
schema is absent from the response. TAB 01 deliberately split `ApplicantApplication` from
`OfficerApplication` so a server mistake could not leak an officer-only field —
schema-based serialisation makes that structural instead of aspirational.

## What is NOT decided here

**Hosting remains open**, and is the reason E-1 stays on the owner-decision list. It is
constrained by the DICT Cloud First Policy, by in-country data residency, and by the
LGU's procurement rules — none of which are engineering questions. Writing Terraform for
an unchosen provider would be speculative work that has to be discarded. See
`docs/ENVIRONMENTS.md` for the resource graph the hosting decision must satisfy, which is
provider-independent and is what should be handed to whoever answers E-1.

## Consequences

- The admin's domain types become a shared package in TAB 04/13 rather than being retyped.
- The team operating this needs TypeScript, not Java or Go. That is a staffing constraint
  the LGU must accept or override — it is the one part of this decision an owner may
  reasonably reverse, and reversing it before deployment costs only this skeleton.
- Node's dependency surface is large, so TAB 14's currency and SBOM requirements matter
  more here than they would for Go. The lockfile is committed and `npm ci` is the only
  install path in the build.
