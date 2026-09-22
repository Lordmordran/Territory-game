import { createClient } from "@supabase/supabase-js";

// Match telemetry — the start of the design doc's "global" AI layer
// (aggregated across players, updated periodically — not live/real-time).
// This key is the public "publishable"/anon one: safe to ship in client code.
// Playing (and submitting telemetry) never requires an account — login is
// optional and only adds permanent, account-linked match history (see the
// `matches.user_id` column). Actually signing in/up happens on public/
// login.html, a standalone page with its own CDN-loaded Supabase client —
// not through this module, which the bundled React app is the only user
// of. This file only needs to read auth *state* (session, admin flag).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// If the env vars are missing (no .env.local, e.g. a fresh clone before
// Supabase is configured) telemetry just quietly does nothing — this is a
// nice-to-have data-collection feature, never something the game depends on.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

// Best-effort, fire-and-forget: a network hiccup or a not-yet-configured
// backend should never affect gameplay, so every failure is swallowed here
// rather than surfaced to the player. `row.user_id` (set by the caller from
// the current session, or omitted/undefined for anonymous play) is just
// another column — this function doesn't need to know about auth at all.
export async function submitMatchTelemetry(row) {
  if (!supabase) return;
  try {
    await supabase.from("matches").insert(row);
  } catch {
    // offline, RLS not set up yet, table doesn't exist yet, etc. — ignored
  }
}

/* ---------------------------------------------------------------------- */
/* Auth state — reading only. Actually signing in/up/resetting a password  */
/* happens on public/login.html; this module only needs to know *whether*  */
/* someone's signed in and let them sign out from within the game itself.  */
/* Never blocks gameplay: every function here degrades to a clear default  */
/* rather than throwing when Supabase isn't configured, same defensive     */
/* posture as telemetry above.                                             */
/* ---------------------------------------------------------------------- */

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Resolves once with whatever session already exists (null if signed out) —
// use this for the initial check on mount, then subscribe with
// onAuthChange for anything after that.
export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

// Fires immediately with the current state, then again on every sign-in/
// sign-out/token-refresh. Returns the unsubscribe function.
export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

// Only meaningful once signed in — resolves false for a signed-out session
// or any error, never throws. The profiles row is created automatically on
// signup (see the on_auth_user_created trigger in supabase/schema.sql), so
// this should always find a row once logged in.
export async function getIsAdmin(userId) {
  if (!supabase || !userId) return false;
  try {
    const { data } = await supabase.from("profiles").select("is_admin").eq("id", userId).single();
    return data?.is_admin ?? false;
  } catch {
    return false;
  }
}
