#!/usr/bin/env bash
# Local e2e: builds the app, forwards real Stripe test webhooks with `stripe listen`, runs Playwright.
# Needs .env.local with STRIPE_SECRET_KEY / NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (test mode) and DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
STRIPE_BIN="${STRIPE_BIN:-stripe}"
PORT=3100
export STRIPE_WEBHOOK_SECRET="$(STRIPE_API_KEY="$STRIPE_SECRET_KEY" "$STRIPE_BIN" listen --print-secret)"
export ADMIN_TOKEN="${ADMIN_TOKEN:-e2e-admin-token-$(date +%s)-abcdef}"
npx tsx scripts/migrate.mts
STRIPE_API_KEY="$STRIPE_SECRET_KEY" "$STRIPE_BIN" listen --forward-to "localhost:$PORT/api/webhooks/stripe" \
  --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.processing,payment_intent.requires_action,payment_intent.canceled,charge.refunded,refund.updated \
  > test-results-stripe-listen.log 2>&1 &
LISTEN_PID=$!
npx next build > /dev/null
npx next start -p $PORT > test-results-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $LISTEN_PID $SERVER_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "localhost:$PORT" > /dev/null && break; sleep 1; done
sleep 2
npx playwright test "$@"
