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

alter table public.matches enable row level security;

-- The client only ever needs to INSERT a row when a match ends. It should
-- never be able to read, edit, or delete anyone's rows (including its own) —
-- that keeps the public key safe to ship in client code: even if someone
-- inspects it, all it lets them do is add more rows, never read or tamper
-- with existing ones. Reading the data for the aggregation job happens from
-- the Supabase dashboard or a server-side job, not the client.
--
-- `to public` (not `to anon`) on purpose: Supabase's newer publishable/secret
-- API keys don't resolve to the classic `anon` Postgres role the old JWT-
-- based anon key did, so a policy scoped to `anon` silently never matched
-- and every insert was rejected. `public` means "any role at all" and sidesteps
-- that entirely — the table still only allows inserts, from anyone, nothing else.
drop policy if exists "Anyone can submit a match result" on public.matches;
create policy "Anyone can submit a match result"
  on public.matches
  for insert
  to public
  with check (true);
