-- recgovme — Supabase schema

-- Watches: each row is one user watching one cabin for specific dates
create table watches (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  facility_id text not null,        -- Recreation.gov campground ID
  facility_name text not null,      -- Human-readable cabin name
  dates text[] not null,            -- Array of YYYY-MM-DD dates to watch
  weekends_only boolean not null default false,
  active boolean not null default true,
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- Index for the worker: fetch all active watches grouped by facility
create index idx_watches_active on watches (active) where active = true;

-- Index for unsubscribe lookups
create index idx_watches_unsub on watches (unsubscribe_token);

-- Notifications: prevents re-alerting for the same opening
create table notifications (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references watches(id) on delete cascade,
  date_found text not null,         -- YYYY-MM-DD that opened up
  sent_at timestamptz not null default now(),
  unique (watch_id, date_found)
);

-- RLS: anon can only INSERT watches (the frontend form)
alter table watches enable row level security;
alter table notifications enable row level security;

create policy "anon_insert_watches"
  on watches for insert
  to anon
  with check (true);

-- The worker uses the service_role key, which bypasses RLS
