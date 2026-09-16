import { createClient } from "@supabase/supabase-js";

// Anonymous match telemetry — the start of the design doc's "global" AI layer
// (aggregated across players, updated periodically — not live/real-time).
// This key is the public "publishable"/anon one: safe to ship in client code,
// and locked down server-side by RLS to insert-only (see the `matches` table
// policy) so it can never read or tamper with anyone else's data.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// If the env vars are missing (no .env.local, e.g. a fresh clone before
// Supabase is configured) telemetry just quietly does nothing — this is a
// nice-to-have data-collection feature, never something the game depends on.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

// Best-effort, fire-and-forget: a network hiccup or a not-yet-configured
// backend should never affect gameplay, so every failure is swallowed here
// rather than surfaced to the player.
export async function submitMatchTelemetry(row) {
  if (!supabase) return;
  try {
    await supabase.from("matches").insert(row);
  } catch {
    // offline, RLS not set up yet, table doesn't exist yet, etc. — ignored
  }
}
