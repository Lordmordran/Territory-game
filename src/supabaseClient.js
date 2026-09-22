import { createClient } from "@supabase/supabase-js";

// Match telemetry — the start of the design doc's "global" AI layer
// (aggregated across players, updated periodically — not live/real-time).
// This key is the public "publishable"/anon one: safe to ship in client code.
// Playing (and submitting telemetry) never requires an account — login is
// optional and only adds permanent, account-linked match history (see
// signUpWithEmail/signInWithEmail below and the `matches.user_id` column).
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
/* Auth — optional login, email + password. Never blocks gameplay: every   */
/* function here degrades to a clear error/null rather than throwing when  */
/* Supabase isn't configured, same defensive posture as telemetry above.   */
/* ---------------------------------------------------------------------- */

export async function signUpWithEmail(email, password) {
  if (!supabase) return { error: "Not configured" };
  const { error } = await supabase.auth.signUp({ email, password });
  return { error: error?.message ?? null };
}

export async function signInWithEmail(email, password) {
  if (!supabase) return { error: "Not configured" };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function resetPassword(email) {
  if (!supabase) return { error: "Not configured" };
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  return { error: error?.message ?? null };
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
