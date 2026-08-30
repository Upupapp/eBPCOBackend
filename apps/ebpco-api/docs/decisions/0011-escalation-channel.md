# ADR 0011 — Email is the record of notice; SMS backs the notices that start a clock

**Status:** Accepted
**Date:** 19 August 2026
**Decides:** Master Command decision **E-9**.

## Context

Push is the obvious channel and the wrong one to rely on. A push to an
uninstalled app reaches nobody, a revoked token reaches nobody, and neither
failure is visible to the LGU. RA 11032 processing periods run against notices
the applicant is assumed to have received, and the LGU may have to *prove* it
gave one.

## Decision

| Channel | When | Muteable |
|---|---|---|
| **Email** | Every notification | No |
| **Push** | Every notification, if a device is registered | **Yes** |
| **SMS** | Notices with a statutory consequence only | No |

`statutory` is not a fresh judgement: it is the mobile client's own `action`
priority. The client had already decided which notices require an act, and those
are exactly the ones whose absence costs the applicant a deadline, a right or
money.

## Reasoning

**Email is the record.** Cheap, archivable, provable, silent — so quiet hours do
not apply to it — and the address is already verified at registration under ADR
0004's tier 1. It is the only channel that costs nothing to send to everyone,
every time, which is what makes it usable as the record.

**SMS for the nine that matter.** Reach in the Philippines is high, delivery
receipts exist, and the mobile number is *already* verified under ADR 0004, so
this needs a provider and no new identity proofing. It costs per message, which
is precisely why it is limited to notices where missing one has a consequence.

**Push is a convenience and can be silenced.** A mute always suppresses the
push, including for a statutory notice. Carving out an exception would make the
setting a lie for a third of the catalog: an applicant would switch it off and
still be buzzed. The notice still arrives — email always, SMS if statutory — and
the feed entry is written regardless, because the LGU must be able to show it
told them.

An earlier draft had statutory notices override the mute on push. That was
wrong, and the Master Command says so plainly: *"muting a category suppresses
the push only"*, with no exception. A test caught it.

**Quiet hours defer, never drop.** A notice that would have arrived at 23:00 is
still a notice. Push and SMS are held to the next open window; email goes
immediately because it makes no noise.

## The property that must hold

No combination of muting, quiet hours and a missing device may result in the LGU
having told nobody anything. There is a test that asserts this across every
catalog entry, every clock position and both device states.

## Consequences

- **An SMS provider is a procurement item**, and it overlaps ADR 0004's mobile
  verification channel. They should be answered together and are probably the
  same vendor. Blocking for any pilot.
- **An email sender is a procurement item too**, and SPF/DKIM/DMARC alignment
  matters: a notice of record in a spam folder is not a notice.
- Delivery outcomes are recorded per channel (`notification_deliveries`), so an
  undelivered statutory notice is visible rather than assumed. Retry and backoff
  belong to TAB 15.
