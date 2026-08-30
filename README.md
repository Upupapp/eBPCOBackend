# eBPCO — backend

One backend estate for the Municipality of Castilla's electronic Building Permit
and Certificate of Occupancy systems, and for the LGU's public information
portal.

## What this backend serves

| Client | Repository | Audience |
|---|---|---|
| Business owner mobile — Android | `Upupapp/eBPCOMobile` | applicants |
| Business owner mobile — iOS | `Upupapp/eBPCOMobile` | applicants |
| Business owner web portal | applicant-facing portal | applicants |
| Admin web portal | `ebpco-admin` | LGU staff |
| Public information portal | `Upupapp/eBPCO-Website` | citizens |

The three business-owner surfaces — Android, iOS and web — are **one product in
three shells**, and are required to be in parity. That is a constraint on this
backend before it is a constraint on any client: a capability that exists for one
of them and not the others is a parity defect here, not a gap over there. The
recorded response samples under each service's `contract/` are the instrument
that makes parity checkable rather than asserted.

## Services

    apps/
      ebpco-api/        the permit transaction system (this is the mature one)
      castilla-portal/  the public information portal API — TAB 00 done, not yet built

Each service owns its own `package.json`, migrations, gate and Dockerfile, and
each deploys independently. They are separate services in one repository, not
one service with two domains — the two run on different machines, hold different
data, and answer to different data-protection postures.

### Why they still share a repository

Interoperability that has to be *enforced* rather than hoped for. The clearest
case: the 19 canonical permit names are held by the permit system, by the admin
portal, and — once built — by the public portal. They match verbatim and in order
today, and nothing checks it. In one repository a single spec can assert both
vocabularies against each other by exact string and index, which is what the
portal's TAB 05 asks for and could not otherwise get.

## Working here

Each service is entered directly:

    cd apps/ebpco-api && npm run verify        # typecheck, lint, tests, audits, build

Docker builds take the **service directory** as their context, not the
repository root:

    docker build -f apps/ebpco-api/Dockerfile apps/ebpco-api

There is deliberately no root `package.json` and no workspace tooling. Two
services with different lifecycles do not need a shared dependency graph, and a
root manifest would invite one.

## History

`apps/ebpco-api` was the repository root until 30 August 2026. It was moved to
make room for a second service; `git log --follow` reaches through the move.
