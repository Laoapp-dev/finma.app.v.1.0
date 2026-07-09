-- Finma — initial schema, migrating from Firebase/Firestore to Supabase.
--
-- Row Level Security (RLS) here plays the exact role firestore.rules used
-- to: it's the server-side enforcement that a user can only ever read/write
-- their own data, regardless of what the client sends. Every table has RLS
-- enabled with `auth.uid() = user_id` (or `= id` for profiles) checks — the
-- Postgres equivalent of `request.auth.uid == userId`.

-- ---------------------------------------------------------------------
-- profiles: one row per user, keyed by their auth.users id
-- (was: users/{uid} in Firestore)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text default '',
  email text default '',
  photo_url text default '',
  primary_currency text not null default 'LAK',
  language text not null default 'en',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Admin can read every profile (e.g. the "registered users" count on the
-- Admin page) — read-only, never write, matching the old isAdmin() read
-- rule in firestore.rules. Keep this email in sync with
-- src/config/admin.js's ADMIN_EMAILS.
create policy "profiles_select_admin" on public.profiles
  for select using (
    (auth.jwt() ->> 'email') = 'berndvh015@gmail.com'
  );

-- ---------------------------------------------------------------------
-- ledger_entries: one row per income/expense transaction
-- (was: users/{uid}/ledgerEntries/{entryId} in Firestore)
-- ---------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  type text not null check (type in ('income', 'expense')),
  category text not null,
  description text default '',
  amount numeric not null,
  currency text not null,
  cycle_key text not null, -- "YYYY-MM", computed client-side from `date`
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_user_cycle_idx
  on public.ledger_entries (user_id, cycle_key);

alter table public.ledger_entries enable row level security;

create policy "ledger_entries_all_own" on public.ledger_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- monthly_cycles: one row per user per month, tracks roll-over balances
-- (was: users/{uid}/monthlyCycles/{yyyy-mm} in Firestore)
-- ---------------------------------------------------------------------
create table if not exists public.monthly_cycles (
  user_id uuid not null references auth.users (id) on delete cascade,
  cycle_key text not null,
  opening_balance numeric not null default 0,
  closed boolean not null default false,
  closing_balance numeric,
  primary key (user_id, cycle_key)
);

alter table public.monthly_cycles enable row level security;

create policy "monthly_cycles_all_own" on public.monthly_cycles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- app_config: single global row, e.g. { maintenanceMode }
-- (was: app_config/global in Firestore)
-- Readable by everyone, including signed-out visitors, so the maintenance
-- screen can show correctly before anyone logs in. Only the admin can write.
-- ---------------------------------------------------------------------
create table if not exists public.app_config (
  key text primary key,
  maintenance_mode boolean not null default false,
  updated_at timestamptz,
  updated_by text
);

insert into public.app_config (key, maintenance_mode)
values ('global', false)
on conflict (key) do nothing;

alter table public.app_config enable row level security;

create policy "app_config_select_all" on public.app_config
  for select using (true);

create policy "app_config_write_admin" on public.app_config
  for all using (
    (auth.jwt() ->> 'email') = 'berndvh015@gmail.com'
  ) with check (
    (auth.jwt() ->> 'email') = 'berndvh015@gmail.com'
  );

-- ---------------------------------------------------------------------
-- Realtime: the app subscribes to live changes on these tables (the
-- Supabase equivalent of Firestore's onSnapshot). Tables must be added to
-- the supabase_realtime publication for that to work.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.ledger_entries;
alter publication supabase_realtime add table public.monthly_cycles;
alter publication supabase_realtime add table public.app_config;
