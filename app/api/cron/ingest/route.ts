import { createServiceClient } from "@/lib/supabase/server"
import { eventSources, type NormalizedEvent } from "@/lib/event-sources"

export const maxDuration = 300

// How far ahead to ingest. The app shows 7 days; we store a little extra so the
// rolling window always stays full between daily runs.
const INGEST_HORIZON_DAYS = 14

type IngestResult = {
  found: number // total events returned by all sources (after de-dup)
  upserted: number
  rowsAdded: number
  duplicatesRemoved: number
  rowsTotal: number
  perSource: Record<string, number>
}

async function ingest(): Promise<IngestResult> {
  const supabase = createServiceClient()

  // Pull from every enabled source. A failing source is logged and skipped so one
  // bad feed never takes down the whole run.
  const collected: NormalizedEvent[] = []
  const perSource: Record<string, number> = {}
  for (const source of eventSources) {
    if (!source.enabled) continue
    try {
      const events = await source.fetchEvents({ horizonDays: INGEST_HORIZON_DAYS })
      perSource[source.name] = events.length
      collected.push(...events)
    } catch (err) {
      perSource[source.name] = -1 // -1 signals the source errored this run.
      console.log("[v0] source failed:", source.name, err instanceof Error ? err.message : err)
    }
  }

  // De-duplicate within this batch by the deterministic id (same key as the PK).
  const seen = new Set<string>()
  const deduped = collected.filter((e) => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
  const duplicatesRemoved = collected.length - deduped.length

  let upserted = 0
  let rowsAdded = 0
  if (deduped.length > 0) {
    // Determine which ids already exist so we can report new rows vs. refreshed rows.
    const ids = deduped.map((e) => e.id)
    const { data: existing } = await supabase.from("events").select("id").in("id", ids)
    const existingIds = new Set((existing || []).map((e: { id: string }) => e.id))
    rowsAdded = deduped.filter((e) => !existingIds.has(e.id)).length

    // Upsert on the primary key so re-running refreshes existing events instead of duplicating.
    const nowISO = new Date().toISOString()
    const { error } = await supabase
      .from("events")
      .upsert(
        deduped.map((e) => ({ ...e, last_updated: nowISO, status: "active" })),
        { onConflict: "id", ignoreDuplicates: false },
      )
    if (error) throw new Error(error.message)
    upserted = deduped.length
  }

  // Clean up events that have already passed so the table stays lean.
  await supabase.from("events").delete().lt("start_time", new Date().toISOString())

  return {
    found: deduped.length,
    upserted,
    rowsAdded,
    duplicatesRemoved,
    rowsTotal: deduped.length,
    perSource,
  }
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  // If no secret is configured, allow (e.g. local/dev). Vercel Cron sends this header automatically.
  if (!secret) return true
  return req.headers.get("authorization") === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Open an ingestion log row (status 'running') so each run is auditable.
  const supabase = createServiceClient()
  let logId: string | null = null
  const startedAt = new Date().toISOString()
  try {
    const { data } = await supabase
      .from("ingestion_logs")
      .insert({ started_at: startedAt, status: "running" })
      .select("id")
      .single()
    logId = (data as { id: string } | null)?.id ?? null
  } catch (err) {
    console.log("[v0] could not open ingestion log:", err instanceof Error ? err.message : err)
  }

  try {
    const result = await ingest()
    console.log("[v0] ingest complete:", result)
    if (logId) {
      await supabase
        .from("ingestion_logs")
        .update({
          finished_at: new Date().toISOString(),
          status: "success",
          rows_added: result.rowsAdded,
          duplicates_removed: result.duplicatesRemoved,
          rows_total: result.rowsTotal,
        })
        .eq("id", logId)
    }
    return Response.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[v0] ingest error:", message)
    if (logId) {
      await supabase
        .from("ingestion_logs")
        .update({ finished_at: new Date().toISOString(), status: "failure", error_message: message })
        .eq("id", logId)
    }
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
