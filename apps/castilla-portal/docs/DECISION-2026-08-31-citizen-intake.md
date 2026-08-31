# Decision: the portal does not collect citizen enquiries

**Status:** Decided
**Date:** 2026-08-31
**Decided by:** the owner, in response to TAB 10's first mandate
**Scope:** `apps/castilla-portal` — the public Castilla information website
**Supersedes:** nothing. This is the first ruling on citizen intake.

TAB 10 of the Castilla Website Backend Master Command requires a written owner
decision *before any intake code is merged*, and offers "not building it" as a
valid deliverable. This is that decision.

## The decision

**The portal will not accept citizen enquiries.** Citizens continue to use the
channels the municipality already publishes: the Municipal Hall counter, the
telephone number, and the email address printed on the contact page. No personal
data is collected by this website.

## What the site does today

The contact page is read-only. Measured at portal commit `55c1cfa`, it contains
**zero form controls** — no `<form>`, no `<input>`, no `<textarea>`, no bound
control of any kind. It publishes five things:

| | |
|---|---|
| Municipal Hall Address | 1st Floor, Municipal Town Hall, Cumadcad, Castilla, Sorsogon |
| Telephone | (056) 311-2112 |
| Official Email | castilla.itdept@gmail.com |
| Office Hours | Monday–Friday, 8:00 AM–5:00 PM |
| LGU Main Website | https://www.castillasorsogon.gov.ph |

An OpenStreetMap frame is offered but **loaded only on request**, a choice the
front-end lane made deliberately so that merely viewing the page does not
disclose a visitor's IP address to a third party.

## Why not

Three reasons, each measured rather than assumed.

**1. There is no privacy notice that could cover intake.** The portal's privacy
policy is still a placeholder awaiting the LGU's own document — one of the three
pages TAB 09 seeds in the `pending` state. Its published text states that the
portal "does not currently collect personal data through forms or accounts."
Building intake would put the site in the position of collecting personal data
under a notice saying it collects none. Under RA 10173 the notice has to come
first, not follow.

**2. There is nowhere to route an enquiry.** TAB 10 requires enquiries be routed
to the office the citizen selects, using the same contact records TAB 03 serves.
**Not one of the 19 offices has a confirmed contact** — all 76 contact fields are
`pending` or `withheld`, because the seeder never auto-confirms without readable
provenance. Every enquiry would fall through to a fallback address. A form whose
routing is 19-for-19 fallback is a form that quietly becomes one shared inbox,
which is the arrangement the municipality already has, without the liability.

**3. Proof-of-humanity would break the privacy claim it exists to protect.**
TAB 10 requires a challenge that does not export the visitor's data to a third
party. That rules out reCAPTCHA, hCaptcha and Turnstile, leaving a self-hosted
challenge to be built and maintained — for a form whose enquiries currently have
one destination.

## What this decision costs

Being explicit about the downside, because a decision record that only argues one
way is advocacy rather than a record:

- A citizen without a phone or email client has no channel from the website
  itself. They must visit the Municipal Hall or use their own mail application.
- There is no record of enquiries, so the LGU cannot measure demand, response
  time, or the questions citizens most often ask.
- The eBPCO permit system has its own applicant channels; this decision does not
  touch them. It is about the public *information* website only.

## What would change it

This is revisitable, and the two preconditions are concrete:

1. **The LGU publishes its own privacy policy**, and it says that enquiry data is
   collected, what is held, for how long, and who may read it.
2. **The offices that would receive enquiries have confirmed contacts**, so
   routing goes somewhere a person actually reads.

When both hold, TAB 10's mandate list is the specification: minimum fields only,
a stated retention period enforced by scheduled deletion rather than by policy,
a self-hosted humanity check, recorded acknowledgements, and a named fallback
that is never a silent drop.

## How this is enforced

`test/no-citizen-intake.spec.ts` asserts the decision rather than trusting it:
the HTTP surface accepts no citizen-supplied payload, and the schema holds no
table for enquiry data. If someone builds intake without replacing this record,
the gate fails.
