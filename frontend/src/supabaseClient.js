/**
 * supabaseClient.js — single Supabase client instance for the whole app.
 *
 * Auth is Supabase's job end to end now (see
 * backend-cloudflare/src/auth/supabase.ts): this app calls
 * signInWithPassword/signUp/signOut directly against Supabase, and
 * sends the resulting session.access_token to the Cloudflare backend
 * as a normal Bearer token. The old /api/v1/auth/login,
 * /register, /refresh, /logout endpoints this frontend used to call
 * don't exist on that backend — see tokenManager.js and api.js.
 *
 * REACT_APP_SUPABASE_URL / REACT_APP_SUPABASE_ANON_KEY must be set at
 * BUILD time (Create React App bakes REACT_APP_* into the bundle) —
 * see NEXT_STEPS.md's Vercel environment variables section. The anon
 * key is meant to be public (it's exposed in the bundle either way);
 * row-level security / this backend's own auth check is what actually
 * protects data, not keeping this key secret.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Don't throw — let the app render so the rest of the UI is
  // inspectable in a misconfigured preview deploy, but every auth call
  // will fail until these are set.
  console.error(
    '[supabaseClient] REACT_APP_SUPABASE_URL / REACT_APP_SUPABASE_ANON_KEY are not set. ' +
    'Auth will not work until these are configured as build-time environment variables.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // needed if you wire up signInWithOAuth later
  },
});
