import { createServiceClient } from "@/lib/supabase/server"
import { eventSources, type NormalizedEvent } from "@/lib/event-sources"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { geocodeAddress } from "@/lib/geo"

// Cap geocoding attempts per run so one ingest can't fan out into hundreds of
// external requests. Events beyond the cap simply keep null coordinates.
const MAX_GEOCODE_PER_RUN = 80

// Best-effort fill of missing coordinates from an event's address/venue/borough.
// Mutates events in place. Failures are silent (the event just stays coordinate-less,
// which means the travel-time filter won't apply to it downstream).
async function enrichCoordinates(events: NormalizedEvent[]): Promise<void> {
  const missing = events.filter((e) => e.latitude === null || e.longitude === null)
  let attempts = 0
  for (const e of missing) {
    if (attempts >= MAX_GEOCODE_PER_RUN) break
    // Prefer a real street address; otherwise fall back to venue/borough text.
    const query = e.address || [e.venue_name, e.borough].filter(Boolean).join(", ")
    if (!query) continue
    const withCity = /new york|ny\b|\bnyc\b/i.test(query) ? query : `${query}, New York, NY`
    attempts++
    const coord = await geocodeAddress(withCity)
    if (coord) {
      e.latitude = coord.lat
      e.longitude = coord.lng
    }
  }
}

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

  // Fill missing coordinates (e.g. SummerStage venues that arrive without geo) so the
  // app's deterministic travel-time filter can apply to them. Best-effort and capped.
  await enrichCoordinates(deduped)

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

  // Clean up only events that have truly FINISHED, anchored to the start of today
  // (NY time). A multi-day event that began earlier but still runs is kept; we delete
  // it only once its end_time has passed. Single-day events (no end_time) are judged
  // by their start_time instead.
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const startOfTodayUTC = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  await supabase
    .from("events")
    .delete()
    .or(
      `and(end_time.not.is.null,end_time.lt.${startOfTodayUTC}),and(end_time.is.null,start_time.lt.${startOfTodayUTC})`,
    )

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
