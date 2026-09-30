import { randomInt } from 'node:crypto'
import { postInvoice, postReceipt, raiseException, schema, withOrg, type Db, type Tx } from '@paysync/db'
import { applyMatch, decide, loadCandidates, lockTransaction } from '@paysync/matching'
import type { Auth } from '../auth.js'
import { normalizeReference } from '../orpc/mappers.js'

export interface DemoOrg {
  readonly orgId: string
  readonly slug: string
  /** The person the agent works for (an accountant, so reversals may be requested). */
  readonly person: { readonly id: string; readonly email: string; readonly name: string }
  readonly approvers: readonly string[]
}

const DAY_MS = 24 * 3_600_000
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS + 3 * 3_600_000).toISOString().slice(0, 10)

/** The backlog the agent works: synthetic demo data, each case chosen to show one behaviour. */
const EXPECTED = [
  { reference: 'HSE-C0', amount: 12_000_00n, due: 2, description: 'October rent, house C0' },
  // Far past due: the rules tier will not auto-match, but the reference is exact.
  { reference: 'HSE-C1', amount: 12_000_00n, due: -150, description: 'May rent, house C1 (late)' },
  { reference: 'HSE-C2', amount: 12_000_00n, due: -150, description: 'May rent, house C2 (late)' },
  { reference: 'STU-104', amount: 7_500_00n, due: 3, description: 'Term 3 fees, student 104' },
  { reference: 'HSE-C3', amount: 12_000_00n, due: 2, description: 'October rent, house C3' },
] as const

const PAYMENTS = [
  { amount: 12_000_00n, billRef: 'HSE-C0', settle: 'HSE-C0' },
  { amount: 12_000_00n, billRef: 'HSE-C1' },
  { amount: 12_000_00n, billRef: 'hse c2' },
  { amount: 7_500_00n, billRef: 'school fees jane' },
  { amount: 12_050_00n, billRef: 'HSE-C3' },
  // The same rent again: already paid by the first payment.
  { amount: 12_000_00n, billRef: 'HSE-C0' },
] as const

async function user(auth: Auth, name: string, email: string, password: string): Promise<string> {
  const { user: created } = await auth.api.signUpEmail({ body: { name, email, password } })
  return created.id
}

/** What the matching job would record for a freshly verified payment. */
async function matchLikeTheWorker(tx: Tx, orgId: string, transactionId: string): Promise<void> {
  const payment = await lockTransaction(tx, transactionId)
  if (!payment) return
  const decision = decide(payment, await loadCandidates(tx))
  if (decision.kind !== 'exception') return
  await raiseException(tx, {
    orgId,
    kind: decision.exception,
    priority: decision.exception === 'duplicate' ? 'high' : 'normal',
    summary: `Payment ${payment.receiptNumber}: ${decision.explanation}`,
    transactionId,
    details: { reason: decision.explanation, candidateIds: [...decision.candidateIds] },
    dedupeKey: `match:${transactionId}`,
  })
}

/** A fresh demo organization per run, so runs never interfere and replay shows one clean session. */
export async function createDemoOrg(auth: Auth, db: Db, password: string): Promise<DemoOrg> {
  const stamp = `${Date.now().toString(36)}${randomInt(1000).toString(36)}`
  const email = (who: string) => `${who}+${stamp}@agent-demo.test`
  const ownerId = await user(auth, 'Demo Owner', email('owner'), password)
  const personId = await user(auth, 'Ada Accountant', email('ada'), password)
  const approverId = await user(auth, 'Ben Admin', email('ben'), password)
  const slug = `agent-demo-${stamp}`
  const org = await auth.api.createOrganization({ body: { name: `Agent demo ${stamp}`, slug, userId: ownerId } })
  await auth.api.addMember({ body: { organizationId: org.id, userId: personId, role: 'accountant' } })
  await auth.api.addMember({ body: { organizationId: org.id, userId: approverId, role: 'admin' } })

  await withOrg(db, org.id, async (tx) => {
    const [code] = await tx
      .insert(schema.shortcode)
      .values({ orgId: org.id, code: `69${String(randomInt(10_000)).padStart(4, '0')}`, kind: 'paybill', environment: 'sandbox', c2bEnabled: true })
      .returning({ id: schema.shortcode.id })
    const references = new Map<string, string>()
    for (const e of EXPECTED) {
      const [row] = await tx
        .insert(schema.expectedPayment)
        .values({ orgId: org.id, reference: e.reference, referenceNormalized: normalizeReference(e.reference), amountDue: e.amount, dueDate: isoDate(e.due), description: e.description, createdBy: ownerId })
        .returning({ id: schema.expectedPayment.id })
      if (!row) continue
      references.set(e.reference, row.id)
      await postInvoice(tx, { orgId: org.id, key: `invoice:${row.id}`, reference: e.reference, delta: e.amount, createdBy: 'agent-demo', reason: 'invoice' })
    }
    for (const [i, p] of PAYMENTS.entries()) {
      // M-Pesa receipts are 10 upper-case letters and digits: AG + 7 from this run + the case number.
      const receiptNumber = `AG${stamp.toUpperCase().padStart(7, '0').slice(-7)}${String(i)}`
      const [row] = await tx
        .insert(schema.mpesaTransaction)
        .values({
          orgId: org.id,
          shortcodeId: code?.id ?? '',
          receiptNumber,
          amount: p.amount,
          transactedAt: new Date(Date.now() - (PAYMENTS.length - i) * 3_600_000),
          source: 'c2b',
          billRefNumber: p.billRef,
          status: 'verified',
          verifiedAt: new Date(),
        })
        .returning({ id: schema.mpesaTransaction.id })
      if (!row) continue
      await postReceipt(tx, { orgId: org.id, transactionId: row.id, receiptNumber, amount: p.amount, createdBy: 'agent-demo' })
      const settles = 'settle' in p ? references.get(p.settle) : undefined
      if (settles) {
        await applyMatch(tx, { orgId: org.id, transactionId: row.id, method: 'exact', parts: [{ expectedPaymentId: settles, amount: p.amount }], createdBy: 'agent-demo' })
      } else {
        await matchLikeTheWorker(tx, org.id, row.id)
      }
    }
  })

  return { orgId: org.id, slug, person: { id: personId, email: email('ada'), name: 'Ada Accountant' }, approvers: [email('ben'), email('owner')] }
}
