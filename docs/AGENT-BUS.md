# eBPCO agent bus and courier

> This is a copy of `/Users/user/.ebpco-bus/README.md`, placed in this repository
> so the lane's agent finds it in its own tree. The store itself is NOT in any
> repository and is local to this Mac. Left uncommitted deliberately: it is this
> lane's decision whether to commit it.

One message store on this Mac, shared by every agent lane of the eBPCO
ecosystem. A lane leaves a message; the next session in the receiving lane is
handed it automatically. It replaces hand-carrying text between chats.

    /Users/user/.ebpco-bus/
    ├── bin/bus          the CLI  — agents and you drive this
    ├── bin/courier      the hook — delivery, invoked by Claude Code
    ├── lanes.json       who exists and which directory is whose
    ├── inbox/<lane>/    open messages, plain markdown with frontmatter
    ├── archive/<lane>/  closed messages
    ├── log.jsonl        append-only audit trail
    └── state/counter    message ids, allocated under a lock

## The lanes

| id | surface | repo | directories |
|---|---|---|---|
| `backend` | serves all four front ends | `Upupapp/eBPCOBackend` | `ebpco-api`, `ebpco-contract` |
| `admin` | LGU staff, Office of the Building Official | `Upupapp/eBPCO-Web` | `ebpco-admin`, `ebpco-web` |
| `citizen-web` | citizen portal, **in parity with mobile** | `Upupapp/eBPCO-WEB-BUSINESSOWNERS` | `ebpco-businessowners` |
| `citizen-mobile` | citizen app, **in parity with web** | `Upupapp/eBPCOMobile` | `eBPCO-Mobile-App` |
| `website` | the public information site | `Upupapp/eBPCO-Website` | `eBPCO-Website` |
| `hub` | your own session at `/Users/user` | — | `/Users/user` exactly |

Groups: `citizen` = both citizen surfaces · `frontends` = all four · `all` = everything.

## Sending

    bus send --to backend --needs FIX \
        --subject "GET /applications returns report_reasons: null" \
        --refs "ebpco-businessowners a6d4444; src/api/applications.ts:88" \
        --body "The list endpoint returns null for every row …"

`--from` is inferred from the working directory, so a lane cannot forge another
lane's name by accident. `--needs` is one of **FIX · WORK · ALIGN · KNOW ·
DECIDE** — the four triggers the owner named, plus DECIDE for a question only
the other lane can answer.

Add `--paste` to also print a paste-ready block, for a lane not on this Mac.

## Receiving

Nothing to run. The courier hook fires on `SessionStart` and on every prompt:

* **SessionStart** hands over the whole open backlog — a fresh session has no
  memory of what was delivered to the last one.
* **UserPromptSubmit** hands over only what has *arrived since*, so a message
  is never repeated into the same session.

A session in a directory no lane owns — Servana, LAGDA, Taytay, Esperanza —
gets **nothing**. The hub lane matches `/Users/user` exactly and does not
swallow the repos beneath it.

## Closing a message

    bus ack   <id> --note "Reproduced, fixing the serializer."
    bus done  <id> --note "Shipped in 161aac5."
    bus block <id> --note "Needs the backend field first."   # --note required
    bus reply <id> --body "…"

Each of these sends a **receipt back to the sender**, so the lane that raised
something learns what happened to it without asking. `--quiet` suppresses the
receipt. `block` refuses to run without a reason, because a block with no
reason tells the sender nothing.

## Two things it deliberately does

**The parity nudge.** Sending to one citizen surface and not the other prints a
warning. The citizen web portal and the mobile app are one product in two front
ends, so a message for one is a candidate for both — and the web portal is the
lane easiest to forget.

**Messages are marked `delivered`, never `done`, by the courier.** Only an
agent closes a message. If a context is compacted away, the message is still
open and the next session gets it again.

## Reading and repair

    bus bind <lane>    pin THIS chat to a lane when the directory cannot tell
                       two chats apart (several sit at /Users/user). Then send
                       one more message; or use --session <id> for an exact bind.
    bus bindings       which sessions are pinned to which lane
    bus id             WHICH CHAT IS THIS? one identity card: lane, repo,
                       HEAD, open inbox, courier state. Works in a non-eBPCO
                       directory too, and says so plainly.
    bus lanes          who exists, with open counts, and which one you are in
    bus inbox [lane]   what is waiting        (--all to include archive)
    bus read <id>      full text
    bus thread <id>    the whole conversation, both directions
    bus log -n 40      the audit trail
    bus doctor         store, lanes, hooks and counter, in one output

If a session ever appears to receive nothing when it should, run the courier by
hand — its errors are swallowed by design, and a swallowed error reads exactly
like an empty inbox:

    echo '{"hook_event_name":"SessionStart","cwd":"/Users/user/ebpco-api"}' \
      | EBPCO_BUS_DEBUG=1 /Users/user/.ebpco-bus/bin/courier

## Scope

Local to this Mac. No git, no push, no network — so nothing here activates the
six-step deploy protocol, and nothing here is published. Messages are plain
markdown: `grep -r` over `inbox/` works, and the bus can be read with `cat`
if the CLI is ever unavailable.
