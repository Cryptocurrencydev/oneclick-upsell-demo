-- Oneclick upsell demo schema. Idempotent: safe to run repeatedly.
-- Production-safety guarantees live HERE, in constraints, not only in app code.

create extension if not exists pgcrypto;

do $$ begin
  create type order_status as enum
    ('pending','paid','upsell_pending','upsell_paid','upsell_failed','refunded');
exception when duplicate_object then null; end $$;

create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  -- client-generated checkout attempt id: a double-submitted checkout form maps to ONE order
  checkout_ref       text not null unique,
  status             order_status not null default 'pending',
  email              text not null,
  stripe_customer_id text,
  payment_method_id  text,               -- saved for off-session use, set from the webhook
  currency           text not null default 'usd',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists line_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  kind         text not null check (kind in ('main','upsell')),
  sku          text not null,
  name         text not null,
  amount_cents integer not null check (amount_cents > 0),
  created_at   timestamptz not null default now(),
  unique (order_id, kind)                -- one upsell line per order, ever
);

-- One row per charge ATTEMPT. The idempotency key sent to Stripe is stored and unique.
create table if not exists charges (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references orders(id) on delete cascade,
  step                     text not null check (step in ('checkout','upsell')),
  attempt                  integer not null default 1 check (attempt >= 1),
  idempotency_key          text not null unique,   -- "<order_id>:<step>:<attempt>"
  stripe_payment_intent_id text unique,
  amount_cents             integer not null check (amount_cents > 0),
  status                   text not null default 'creating'
                           check (status in ('creating','processing','requires_action','succeeded','failed','refunded')),
  failure_code             text,
  failure_message          text,
  last_event_created       bigint,                  -- Stripe event.created of the last applied event (ordering guard)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (order_id, step, attempt),
  constraint idem_key_shape check (idempotency_key = order_id::text || ':' || step || ':' || attempt)
);

-- THE double-charge guard: at most one non-failed charge per (order, step).
-- A retry after a decline is a new attempt, but two live attempts can never coexist.
create unique index if not exists one_live_charge_per_step
  on charges (order_id, step) where status <> 'failed';

create table if not exists refunds (
  id               uuid primary key default gen_random_uuid(),
  charge_id        uuid not null unique references charges(id),  -- one refund per upsell charge
  idempotency_key  text not null unique,
  stripe_refund_id text unique,
  amount_cents     integer not null,
  status           text not null default 'creating',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Webhook replay protection: Stripe event ids are processed at most once.
create table if not exists stripe_events (
  id           text primary key,
  type         text not null,
  created      bigint not null,
  processed_at timestamptz not null default now(),
  outcome      text
);

-- Audit log: every order state transition.
create table if not exists order_events (
  id              bigserial primary key,
  order_id        uuid not null references orders(id) on delete cascade,
  from_status     order_status,
  to_status       order_status not null,
  reason          text not null,
  source          text not null check (source in ('api','webhook','reconcile','admin')),
  stripe_event_id text,
  created_at      timestamptz not null default now()
);
create index if not exists order_events_order_idx on order_events(order_id, id);
