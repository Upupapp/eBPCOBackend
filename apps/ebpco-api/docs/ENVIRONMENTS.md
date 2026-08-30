# Environments

Three, and the difference between them is configuration only. The same image runs in all
three; nothing is compiled differently for production.

| | development | staging | production |
|---|---|---|---|
| Data | synthetic | **synthetic only** | real applicant data |
| `DOCS_ENABLED` | may be true | may be true | **rejected at boot if true** |
| HSTS | off | on | on |
| TLS | optional | required | required |
| Deploys | any time | on merge | explicit recorded approval |

**Staging never holds real applicant data.** That is a privacy control under RA 10173,
not a convenience: a copy of production in a lower environment is a second population of
personal data with weaker access controls and no separate lawful basis. TAB 04 seeds
staging from synthetic fixtures.

## Configuration

Every varying value comes from the environment and nowhere else. There is **no default
for any backing service** — a default database URL is a service that starts successfully
while talking to the wrong thing. The service validates its whole environment at boot,
reports every problem at once, and exits `78` (`EX_CONFIG`) rather than starting
half-configured.

See `.env.example` for the complete list. `.env` is gitignored and is read only in
development; staging and production set real environment variables, and the service must
be able to start with no file present.

## The resource graph hosting must satisfy

Provider-independent, because **E-1's hosting half is still open** and is constrained by
the DICT Cloud First Policy, in-country data residency, and LGU procurement — none of
which are engineering questions. This is what should be handed to whoever answers it.

```
                    ┌──────────────────────────┐
   public ─── TLS ─►│  Ingress / load balancer │  terminates TLS, adds
                    │  polls /health, /ready   │  X-Forwarded-For
                    └────────────┬─────────────┘
                                 │  (TRUST_PROXY=true only here)
                    ┌────────────▼─────────────┐
                    │  eBPCO API (N replicas)  │  stateless, read-only rootfs,
                    │  non-root, memory-capped │  no local persistence
                    └──┬────────┬──────────┬───┘
                       │        │          │
        ┌──────────────▼──┐  ┌──▼────────┐ │  ┌──────────────────┐
        │ PostgreSQL 16+  │  │ S3-compat │ │  │ Secret manager   │
        │ private subnet  │  │ object    │ │  │ DB creds, keys   │
        │ encrypted, PITR │  │ store     │ │  │ rotated          │
        └─────────────────┘  │ private,  │ │  └──────────────────┘
                             │ encrypted │ │
                             └───────────┘ │
                             ┌─────────────▼──┐
                             │ Malware scanner│  non-critical: uploads are
                             │ (ICAP/clamd)   │  held, service stays up
                             └────────────────┘
```

Requirements on whatever provider is chosen:

- **Data residency in the Philippines**, or wherever the LGU's counsel confirms is lawful
  for personal data under RA 10173.
- **Private networking** — the database and object store are never reachable from the
  public internet, only from the API's subnet.
- **Encryption at rest** on database and object store; **no public ACL possible** on the
  bucket.
- **Point-in-time recovery** on the database, with a restore that has actually been
  rehearsed and timed (TAB 04 acceptance).
- **A secret manager**, so no credential is ever an environment variable set by hand or a
  value in a repository.
- **At least two availability zones**, or a documented and accepted single-zone risk.

## Infrastructure as code

Not yet written, deliberately. Terraform for an unchosen provider is speculative work
that gets discarded when E-1 is answered. The graph above is the specification it must
implement, and TAB 02 is recorded as **partially complete** for this reason rather than
claiming an IaC deliverable that does not exist.
