import { createClient } from "@supabase/supabase-js";

// Populate these from your Supabase project (Project Settings > API) and
// store them in a `.env.local` file (see `.env.example`) for local dev, or
// as GitHub Actions repository secrets for deployed builds — never commit
// real keys to source control. The anon key is safe to ship in a client
// bundle (Row Level Security policies, not secrecy of this key, are what
// actually protect your data — see supabase/migrations/0001_init.sql).
const supabaseConfig = {
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
};

// If a secret was never set (e.g. a GitHub Actions secret name was
// mistyped), createClient() throws and — without this guard — the whole
// app crashes to a blank white screen with only a console error to go on.
// `isSupabaseConfigured` lets App.jsx/ConfigBanner show a clear message
// instead.
export const isSupabaseConfigured = Boolean(supabaseConfig.url && supabaseConfig.anonKey);

export const missingSupabaseKeys = Object.entries({
  VITE_SUPABASE_URL: supabaseConfig.url,
  VITE_SUPABASE_ANON_KEY: supabaseConfig.anonKey,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

export let supabase;

if (isSupabaseConfigured) {
  supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);

  // Diagnostic only — helps catch a mismatch between the project this
  // build is actually talking to and whatever project a migration/RLS
  // policy got deployed to. Compare against Project Settings > General >
  // Reference ID in the Supabase dashboard you're checking.
  console.info("[Finma] Connected Supabase project:", supabaseConfig.url);
}

// Suggested Postgres layout (see supabase/migrations/0001_init.sql for the
// actual DDL + Row Level Security policies):
//   profiles(id uuid PK -> auth.users.id, name, email, photo_url,
//            primary_currency, language, created_at)
//   ledger_entries(id uuid PK, user_id uuid -> auth.users.id, date, type,
//            category, description, amount, currency, cycle_key)
//   monthly_cycles(user_id uuid, cycle_key text, opening_balance, closed,
//            closing_balance — PK (user_id, cycle_key))
//   app_config(key text PK, maintenance_mode, updated_at, updated_by)
