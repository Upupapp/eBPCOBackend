# Response-time budgets

The portal is 73 kB of initial transfer today with every fact compiled in, so it
is fast by construction. Putting a database behind it can only make it slower;
the job is to make that difference invisible. These are the budgets each public
endpoint is held to, and `test/caching.spec.ts` fails when one is exceeded.

Measured against a **cold cache** — every request a miss, every query executed —
because a budget met only when warm is a budget met only when it does not
matter.

| Endpoint | Budget | Why this number |
|---|---|---|
| `GET /offices` | 60 ms | One query, 19 rows, no joins. |
| `GET /offices/{slug}` | 120 ms | Five queries: the office, services, contacts, relations, issued permits. |
| `GET /officials` | 60 ms | One query with a state join. |
| `GET /municipality/profile` | 60 ms | One query, 11 rows, plus a format check per magnitude. |
| `GET /permits` | 80 ms | One query, 19 rows, grouped in memory. |
| `GET /permits/{slug}` | 80 ms | Two queries: the permit and its requirements. |
| `GET /pages` | 120 ms | Five pages, each read individually — the honest cost of keying by meaning. |
| `GET /forms` | 80 ms | One query. Deliberately excludes the bytes. |
| `GET /search?q=…` | 100 ms | One GIN-indexed full-text query. |
| `GET /announcements` | 80 ms | One indexed query plus a count. |
| `GET /announcements/count` | 40 ms | One integer from a partial index. The tightest budget: it is called on every page load of every page. |

A **304 revalidation** is held to **15 ms** for every endpoint, because it does
no database work at all — the ETag is computed from a version counter before the
handler runs. If a 304 ever approaches a miss, the short-circuit has been lost.

These are generous on purpose. They are a regression alarm, not a performance
target: a number that trips on ordinary variance gets muted, and a muted check
is worse than none.
