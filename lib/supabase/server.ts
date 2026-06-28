import { createClient } from "@supabase/supabase-js"

// Server-only Supabase client using the service role key. The events table is
// public-read via RLS, but the daily cron job writes with the service role
// (which bypasses RLS). Never import this into a Client Component.
export function createServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables")
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
