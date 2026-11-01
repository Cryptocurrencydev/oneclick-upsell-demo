# One-click upsell demo

**Live demo: https://oneclick-upsell-demo.vercel.app** (Stripe test mode: pay with `4242 4242 4242 4242`, any future date and CVC)

A small checkout for a **fictional** tea brand (Fernhollow Tea Co.), built to show the kind of flow a checkout platform ships: buyer pays → sees a post-purchase offer → one click charges the **saved card off-session** → one order with two line items.

**Stripe TEST mode only.** The server refuses to start with a non-test key, and the webhook handler rejects live-mode events.

Stack: Next.js 16 (App Router) + TypeScript · Postgres (Neon in prod, local Postgres in tests) · Stripe Payment Element + PaymentIntents · Vitest + Playwright.

## Flow

| Page | What happens |
|---|---|
| `/` checkout | Payment Element (cards only). `POST /api/checkout` creates the order + PaymentIntent with `setup_future_usage: off_session`. |
| `/upsell/:id` | Waits until **the webhook** marks the order `paid` (the browser redirect proves nothing). Then "Add to my order ($14)": one click, off-session charge, no card re-entry. Handles decline, 3DS (`requires_action`) and retry. |
| `/orders/:id` | One order, main and upsell line items, total, plus the full transition audit trail. |
| `/admin` | Bearer-token protected. Refunds **only the upsell**, idempotently. |

## Production-safety design

**Order state machine (Postgres enum + `lib/state-machine.ts`)**

```
pending → paid → upsell_pending → upsell_paid → refunded
                       ↑   ↓
                  upsell_failed   (retry = new attempt)
```
Illegal edges throw and write nothing. Every transition goes into `order_events` (from, to, reason, source `api|webhook|reconcile|admin`, Stripe event id) in the same transaction as the status change.

**Idempotency: no double charges**
- Every Stripe charge uses the idempotency key `"<order_id>:<step>:<attempt>"`. A DB `CHECK` constraint enforces that shape, and the key column is `UNIQUE`.
- Partial unique index `one_live_charge_per_step`: at most **one non-failed charge per (order, step)**, so two live upsell charges can't exist even if the app code is wrong.
- Upsell endpoint: `SELECT … FOR UPDATE` on the order plus a state check. A double click, a refresh or 20 parallel POSTs all collapse into one charge attempt. The Stripe call runs *outside* the transaction (no row locks held across the network).
- Lost responses (Stripe charged, the socket died) are retried with the **same key**. If every retry fails, the attempt stays `creating` and reconciliation re-sends it with the same key: Stripe returns the original PaymentIntent and never creates a second one.
- Checkout double-submit: a client-generated `checkout_ref` (unique) maps resubmits to the same order + PaymentIntent.
- Refunds: `refunds.charge_id UNIQUE` plus key `"<order>:upsell-refund:1"`. Pressing refund twice returns the existing refund.

**Webhooks (`lib/webhooks.ts`)**
- Signatures are verified on the raw body (with Stripe's 5-minute tolerance). Bad or missing signatures get a 400 and nothing is recorded.
- `stripe_events(id PRIMARY KEY)`: a replayed event is acknowledged (200) and ignored. The event insert and its effects commit in **one transaction**, so if processing fails nothing is recorded, we return 500 and Stripe's retry is applied.
- Out-of-order safe: charges keep `last_event_created`, older events are ignored, and charge status is monotonic (a late `payment_failed` can't undo `succeeded`). Only the *latest* attempt may move the order, so a late event for an old failed attempt can't hijack a retry. An amount/currency mismatch never marks anything paid.
- Webhooks and the synchronous API path share one function (`applyPaymentIntent`), so they can't disagree. A server-side reconcile (asks Stripe, never trusts the client) runs only for charges stuck in a non-terminal state for more than 5s.

**Upsell failures**
- Decline → `upsell_failed`, a clear message, "Try again" (a new attempt with a new key, max 3) and "Continue without it". Non-retryable declines (stolen/lost/fraudulent/expired) get no retry button.
- 3DS → the off-session charge returns `authentication_required`, the order stays `upsell_pending` and the UI shows "Confirm with my bank" (`confirmCardPayment` with the saved card, no re-entry). The webhook settles it, and "Skip" cancels the PaymentIntent.

## Run it

```bash
cp .env.example .env.local        # add Stripe TEST keys; never commit them
npm install
npm run db:migrate                # applies db/schema.sql (idempotent)
npm run dev
npm test                          # vitest (needs Postgres; see vitest.config.mts)
npm run test:e2e                  # build + `stripe listen` + Playwright, real Stripe test mode
```

Test cards: `4242 4242 4242 4242` success · `4000 0000 0000 0002` decline · `4000 0027 6000 3184` 3DS.

## How this was built

**Agent:** Claude Code (Claude Opus 5.5) in one terminal session, 1 Nov 2026. A human supplied the spec, the Stripe test keys and the Neon terms acceptance. All code, tests, debugging and deployment were done by the agent.

**Timeline** (wall clock, from the session's timestamp log):

| Phase | Time | Notes |
|---|---|---|
| Scaffold, deps, tooling | ~6 min | Next 16 + TS. Homebrew couldn't build the Stripe CLI on this macOS, so the agent pulled the official release binary instead |
| Schema + payment core (state machine, idempotency, webhooks, refunds) | ~4 min | Constraints first: the DB enforces the guarantees, not just app code |
| API routes + UI (checkout, upsell, confirmation, admin) | ~3 min | |
| Vitest suite + mutation checks | ~4 min | 39 tests against real Postgres with a fake Stripe that models idempotency-key semantics |
| Playwright suite + Vercel/Neon setup | ~2 min | |
| *Waiting on human (Stripe keys, Neon terms)* | *~10 min* | *not counted* |
| E2E against real Stripe test mode + fixing what it found | ~32 min | includes one ~10 min hung run |
| Deploy, register webhook, e2e against the live URL | ~6 min | |
| **Total agent time** | **~57 min** | ~68 min wall clock |

Most of the time went into verification, not writing code, which is the intended split.

**How it was verified before "going live"**

1. **Vitest, 39 tests** on a real Postgres (so unique indexes and row locks are actually exercised):
   - State machine edges.
   - Concurrency: 20 simultaneous clicks forced to pile up behind a held row lock.
   - DB constraint violations.
   - Webhooks: forged, tampered and missing signatures; replays; out-of-order events; a mid-processing failure, then Stripe's retry; amount mismatch.
   - Upsell failures: declines, non-retryable declines, the retry cap, 3DS success/fail/skip, lost network responses.
   - Refunds: 10 concurrent refund requests produce 1 Stripe refund.
2. **Mutation checks.** The agent deleted the guards and confirmed the tests fail. The first concurrency test *passed* with the row lock removed (requests never actually overlapped). It was rewritten to force the race and now fails without the lock. Dropping the partial unique index is also caught.
3. **Playwright, 6 tests on real Stripe test mode**, with webhooks forwarded by `stripe listen`. Charge counts are checked **with the Stripe API**, not just the UI:
   - 4242 happy path (`paid` must come from the webhook).
   - Double-click plus 5 parallel POSTs → exactly 1 upsell PaymentIntent.
   - Decline at checkout, then retry → 1 order.
   - Off-session upsell decline.
   - 3DS card (authenticate at checkout, then again for the off-session upsell).
   - Admin refund pressed twice → 1 refund of $14, and the $28 main charge untouched.
4. **The same 6 Playwright tests against the live Vercel URL** (Neon Postgres, real Stripe webhook endpoint): 6/6 pass.
5. **Live smoke checks:** unsigned or forged webhook → 400, admin without token → 401.

**Real bugs these checks caught (all fixed):**
- The production build caught the checkout id being generated at prerender time. **Every visitor would have shared one order.**
- E2E caught the Payment Element offering Link "Bank" payments that the server PaymentIntent doesn't allow (buyers would hit an error at pay time).
- E2E caught the admin refund confirmation being cleared instantly by a table refresh.
- Mutation testing caught the concurrency test that couldn't fail (see above).

Test-only fixes along the way: Stripe's 3DS2 test page drops clicks that land before it's ready; card-number changes resize Stripe's iframe and move the Pay button mid-click; parallel test runs collided on `Date.now()` emails.

**Secrets:** keys are only in `.env.local` / `.env.production.local` (gitignored) and Vercel env vars. They were never committed or typed into chat. The app refuses non-test keys.

**Known limits (it's a demo):** order pages are protected only by their unguessable UUID; there's no inventory, tax or shipping; "refunded" in the state machine means *upsell refunded* (the main charge is never refunded here); admin auth is a single bearer token.
