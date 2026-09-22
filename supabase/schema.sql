-- territory-game: anonymous match telemetry
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: the IF NOT EXISTS / OR REPLACE guards make it idempotent.

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  outcome text not null check (outcome in ('won', 'lost')),
  match_length_ms integer,
  first_barracks_ms integer,
  first_attack_ms integer,
  first_attack_power numeric,
  app_version text
);

-- Added later: every successful placement the player made that match (builds
-- AND land claims), not just the three summary milestones above — one JSON
-- array per match, e.g. [{"t": 4210, "kind": "build", "defId": "lumberCamp",
-- "r": 15, "c": 6}, {"t": 8900, "kind": "claim", "defId": null, "r": 15, "c": 7}, ...].
-- `t` is ms since that match's own start, so it's comparable across matches
-- regardless of wall-clock time. `if not exists` makes this safe to re-run
-- alongside the rest of this file.
alter table public.matches add column if not exists build_log jsonb;

alter table public.matches enable row level security;

-- The client only ever needs to INSERT a row when a match ends. It should
-- never be able to edit or delete anyone's rows (including its own) — that
-- keeps the public key safe to ship in client code: even if someone
-- inspects it, all it lets them do is add rows, never tamper with existing
-- ones. (Read access is handled separately below, and — since accounts were
-- added — is no longer open to just anyone with the key; see the
-- account-scoped SELECT policy near the bottom of this file.)
--
-- `to public` (not `to anon`) on purpose: Supabase's newer publishable/secret
-- API keys don't resolve to the classic `anon` Postgres role the old JWT-
-- based anon key did, so a policy scoped to `anon` silently never matched
-- and every insert was rejected. `public` means "any role at all" and sidesteps
-- that entirely.
drop policy if exists "Anyone can submit a match result" on public.matches;
create policy "Anyone can submit a match result"
  on public.matches
  for insert
  to public
  with check (true);

-- ------------------------------------------------------------------------
-- Accounts (2026-09-22): optional login so a player's match history can
-- follow their account instead of just one browser/device. Playing without
-- an account still works exactly as before -- login only adds permanence.
-- ------------------------------------------------------------------------

-- One row per signed-up user, auto-created by the trigger below. Only
-- field that matters right now is is_admin -- a plain on/off flag Tyler
-- grants himself (or anyone else, later) directly via SQL, not hardcoded
-- into the app. Deliberately NOT storing anything else here (no email
-- duplicate, no display name) -- auth.users already has what auth needs,
-- and this project doesn't show usernames anywhere.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- Auto-create the profiles row the moment someone signs up, so the app
-- never has to special-case "logged in but no profile row yet".
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- security definer so a matches RLS policy can check "is the current user
-- an admin" without needing its own separate read access into profiles
-- (and without any risk of RLS-recursion weirdness from one policy
-- querying a table that has its own RLS).
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Which account a match belongs to, if any -- null for anonymous play
-- (still fully supported; login is optional, never required to play).
alter table public.matches add column if not exists user_id uuid references auth.users(id);

-- Replaces the old "anyone can insert" check: still open to everyone
-- (anonymous play keeps working), but a signed-in submitter can only ever
-- tag a match as their own account, never someone else's.
drop policy if exists "Anyone can submit a match result" on public.matches;
create policy "Anyone can submit a match result"
  on public.matches
  for insert
  to public
  with check (user_id is null or user_id = auth.uid());

-- Replaces the old fully-open read policy. Battle Log now requires being
-- signed in to see anything at all: a regular user sees only their own
-- matches, an admin (is_admin() above) sees every match, same as the old
-- open policy used to allow for everyone.
drop policy if exists "Anyone can read match results" on public.matches;
create policy "Users can read their own matches, admins can read all"
  on public.matches
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());
