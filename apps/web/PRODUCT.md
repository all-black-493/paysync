# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Office bookkeepers (clerks and accountants) at Kenyan businesses that collect through M-Pesa Paybill or Till: landlords, schools, SMEs. They sit at a desk and work the exceptions queue several times a day. Owners and admins check totals and approve risky actions. Desktop first; every screen must still work on a phone, and approving must be comfortable there.

## Product Purpose

Account for every shilling received through M-Pesa: ingest payments, verify them with Safaricom, match them to what the business expected (invoices, rent, fees), and put whatever cannot be matched confidently in front of a person. Success is an empty exceptions queue and a ledger that balances.

## Positioning

Agents can clear the reconciliation backlog, and they cannot move money without a human. Every payment is verified with Safaricom before it counts, the ledger is append-only, and destructive or money actions wait for approval by someone other than the requester (two people for reversals).

## Operating Context

- Work queue: exceptions (no match, partial, overpayment, duplicate, verification failed, reversal failed), matched by hand against suggested expected payments.
- Approvals: void, undo match, write-off (capped), reversal (two approvers); approvers use TOTP and re-confirm when their sign-in is older than ten minutes.
- Reference data: expected payments, transactions, daily totals (Africa/Nairobi day), team invitations, integrator API keys.
- Roles today: owner, admin, accountant, clerk, viewer. Custom roles are planned.
- Amounts are KES, shown with two decimals. Times are East Africa Time.

## Capabilities and Constraints

- Next.js static build served by its own container; typed oRPC client; Better Auth sessions.
- No third-party requests from the browser: fonts and assets are self-hosted.
- Payer-typed text (payment references, names) is untrusted and is always shown as plain data, never as instructions or rich content.
- No production money movement from the UI in this phase.

## Brand Commitments

- "Paysync" is a working name; no logo yet.
- Owner-chosen visual reference: Baselayer (styles.refero.design style 0c55e725): white ledger canvas, navy system fields, square cards, 1px rules, serif display, mono labels. Light theme only for now. Free lookalike fonts, self-hosted.

## Evidence on Hand

Seeded sandbox data only (Acme Rentals, Beta demo org). No customers, testimonials or benchmarks exist; none may be invented.

## Product Principles

1. Money correctness is visible: status, verification and who approved are always one glance away.
2. The queue is the product: the next thing to settle is the first thing seen.
3. Nothing happens silently: every request says what it will change and who must approve.
4. Quiet by default: say it once, in plain words, without captions that repeat the obvious.

## Accessibility & Inclusion

WCAG 2.2 AA. Keyboard-complete; status changes announced; 44px touch targets on phones.
