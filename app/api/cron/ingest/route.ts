import { createHash } from "crypto"
import { generateText, Output } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/server"
import { normalizeSourceUrl, isWrongCityUrl, isUrlReachable, bestCitationFor } from "@/lib/event-links"

// Stable UUID derived from the dedupe key (title + start time + venue). Re-ingesting the
// same event produces the same id, so upsert on the primary key naturally de-duplicates.
function deterministicId(title: string, dateTimeIso: string, venue: string): string {
  const key = `${title.toLowerCase().trim()}|${dateTimeIso}|${(venue || "").toLowerCase().trim()}`
  const h = createHash("sha256").update(key).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export const maxDuration = 300

// Category groups searched each day. Grouping keeps the number of AI calls low
// (important for AI Gateway rate limits) while still covering a broad range of interests.
const CATEGORY_GROUPS = [
  "live music, concerts, DJ sets and nightlife, stand-up comedy",
  "theater, performing arts, dance, film screenings, author talks and literary readings",
  "art exhibitions, museum shows, gallery openings, markets and craft fairs, family and kids activities",
  "food and drink festivals, running races and run clubs, fitness classes, outdoor and park events, wellness and yoga",
]

const INGEST_HORIZON_DAYS = 14
const PER_GROUP_LIMIT = 12

const ingestEventSchema = z.object({
  title: z.string(),
  description: z.string().describe("1-2 sentence description of the event"),
  category: z.string().describe("a short category label, e.g. 'Live Music', 'Theater', 'Running'"),
  date: z.string().describe("exact calendar date in ISO format YYYY-MM-DD"),
  time: z.string().describe("start time in 24h HH:MM; empty string if unknown"),
  venue: z.string(),
  address: z.string().describe("full street address including borough; empty string if unknown"),
  url: z.string().describe("a real link to the specific event or its venue; empty string if none"),
  source: z.string().describe("the publication or website the listing came from, e.g. 'Time Out', 'Eventbrite'"),
  price: z.string().describe("e.g. Free, $, $$, $25; empty string if unknown"),
})

const ingestSchema = z.object({ events: z.array(ingestEventSchema) })

// The horizon of allowed ISO dates (today + N days, anchored to NYC time).
function horizonDates(days: number) {
  const out: string[] = []
  const nyToday = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
  nyToday.setHours(0, 0, 0, 0)
  for (let i = 0; i < days; i++) {
    const d = new Date(nyToday.getTime() + i * 86400000)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)
  }
  return out
}

// Convert a NYC wall-clock date + time into a UTC ISO timestamp, handling DST correctly.
function nyToUtcISO(date: string, time: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const [hh, mm] = (time && /^\d{1,2}:\d{2}$/.test(time) ? time : "00:00").split(":").map(Number)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm)
  // Difference between how this instant reads in NY vs UTC gives the offset to apply.
  const nyStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "America/New_York" })
  const utcStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" })
  const offsetMs = new Date(utcStr).getTime() - new Date(nyStr).getTime()
  return new Date(utcGuess + offsetMs).toISOString()
}

async function researchGroup(categories: string, dateList: string[]) {
  const research = await generateText({
    model: "perplexity/sonar-pro",
    system:
      "You are a meticulous New York City events researcher. Search the live web for REAL, currently-scheduled events in NYC happening on the specific upcoming dates. Only include things that genuinely exist with real venues and a working listing/ticket URL. " +
      "SOURCE COVERAGE: cross-reference a broad range of authoritative NYC sources — NYC Parks & NYC.gov calendars, Time Out New York, The Skint, Secret NYC, NYC Tourism, Eventbrite, Meetup, Dice, Resident Advisor, Bandsintown, Songkick, official venue/museum/gallery sites, NYPL/BPL/QPL libraries, NYRR and studio sites. Prefer primary/official sources. " +
      "NEIGHBORHOOD COVERAGE: span many neighborhoods across all five boroughs, not just one area. " +
      "Every event MUST be in New York City — never another city. Provide the event's own page or its venue's page, never a generic 'events calendar' roundup when a specific page exists.",
    prompt: `Find up to ${PER_GROUP_LIMIT} real NYC events in these categories: ${categories}.\nThey must occur on one of these exact dates: ${dateList.join(", ")}.\nFor each event give: title, 1-2 sentence description, a specific category label, exact ISO date (YYYY-MM-DD), start time (24h), venue name, full street address with borough, price, the source website name, and a working URL to the specific event or venue.`,
  })

  const citations = ((research.sources as any[]) || [])
    .filter((s) => typeof s?.url === "string" && s.url.length > 0)
    .map((s) => {
      let host = ""
      try {
        host = new URL(s.url).hostname.replace(/^www\./, "")
      } catch {
        host = ""
      }
      return { title: (s.title as string) || host || s.url, url: s.url as string }
    })

  const structured = await generateText({
    model: "openai/gpt-5-mini",
    experimental_output: Output.object({ schema: ingestSchema }),
    providerOptions: { openai: { reasoningEffort: "minimal" } },
    system:
      "Convert the research notes into a structured list of NYC events. Keep only real events mentioned in the notes. " +
      "DATE RULE: set 'date' to the exact ISO date (YYYY-MM-DD); it MUST be one of the allowed dates. Drop events outside that list. " +
      "URL RULE: set 'url' to a real, complete http(s) link to the specific event or its venue from the CITATIONS or notes — never invent a URL, never a bare domain, never a search-engine URL, and NEVER a page for a city other than New York City. If no real NYC link exists, drop the event. " +
      "Set 'source' to the website/publication name the listing came from.",
    prompt: `Allowed dates: ${dateList.join(", ")}\n\nCITATIONS (real links — format "title — url"):\n${citations.map((c) => `${c.title} — ${c.url}`).join("\n") || "(none)"}\n\nResearch notes:\n${research.text}`,
  })

  return { events: structured.experimental_output.events, citations }
}

type IngestResult = {
  found: number
  ingested: number
  upserted: number
  rowsAdded: number
  duplicatesRemoved: number
  rowsTotal: number
}

async function ingest(): Promise<IngestResult> {
  const supabase = createServiceClient()
  const dateList = horizonDates(INGEST_HORIZON_DAYS)
  const allowed = new Set(dateList)

  // Matches the public.events schema. Columns without a source during ingestion
  // (borough, neighborhood, tags, organizer, end_time, currency, image_url, etc.)
  // are left to their table defaults.
  type Row = {
    id: string
    title: string
    description: string | null
    category: string | null
    start_time: string
    venue_name: string | null
    address: string | null
    latitude: null
    longitude: null
    event_url: string | null
    source: string | null
    price: string | null
  }

  const collected: { row: Row; url: string }[] = []

  for (const group of CATEGORY_GROUPS) {
    try {
      const { events, citations } = await researchGroup(group, dateList)
      for (const e of events) {
        if (!allowed.has(e.date)) continue
        // Resolve the best real, NYC, reachable link.
        const modelUrl = normalizeSourceUrl(e.url)
        const usableModelUrl = modelUrl && !isWrongCityUrl(modelUrl) ? modelUrl : null
        const url = usableModelUrl ?? bestCitationFor({ venue: e.venue, title: e.title }, citations) ?? ""
        if (!url) continue
        const dateTime = nyToUtcISO(e.date, e.time)
        if (!dateTime) continue
        collected.push({
          url,
          row: {
            id: deterministicId(e.title, dateTime, e.venue || ""),
            title: e.title,
            description: e.description || null,
            category: e.category || null,
            start_time: dateTime,
            venue_name: e.venue || null,
            address: e.address || null,
            latitude: null,
            longitude: null,
            event_url: url,
            source: e.source || null,
            price: e.price || null,
          },
        })
      }
    } catch (err) {
      console.log("[v0] ingest group failed:", group, err instanceof Error ? err.message : err)
    }
  }

  // Verify links are live in parallel; drop dead/unreachable ones.
  const reachable = await Promise.all(collected.map((c) => isUrlReachable(c.url)))
  const rows = collected.filter((_, i) => reachable[i]).map((c) => c.row)

  // De-duplicate within this batch by the deterministic id (same key as the PK).
  const seen = new Set<string>()
  const deduped = rows.filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
  // Rows discarded as duplicates: dead-link drops + repeated keys within the batch.
  const duplicatesRemoved = collected.length - deduped.length

  let upserted = 0
  let rowsAdded = 0
  if (deduped.length > 0) {
    // Determine which ids already exist so we can report new rows vs. refreshed rows.
    const ids = deduped.map((r) => r.id)
    const { data: existing } = await supabase.from("events").select("id").in("id", ids)
    const existingIds = new Set((existing || []).map((e: { id: string }) => e.id))
    rowsAdded = deduped.filter((r) => !existingIds.has(r.id)).length

    // Upsert on the primary key so re-running refreshes existing events instead of duplicating.
    const { error } = await supabase
      .from("events")
      .upsert(
        deduped.map((r) => ({ ...r, last_updated: new Date().toISOString(), status: "active" })),
        { onConflict: "id", ignoreDuplicates: false },
      )
    if (error) throw new Error(error.message)
    upserted = deduped.length
  }

  // Clean up events that have already passed so the table stays lean.
  await supabase.from("events").delete().lt("start_time", new Date().toISOString())

  return {
    found: collected.length,
    ingested: deduped.length,
    upserted,
    rowsAdded,
    duplicatesRemoved,
    rowsTotal: deduped.length,
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
