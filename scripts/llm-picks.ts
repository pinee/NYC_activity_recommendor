// Replicates the PRODUCTION LLM curation step (app/api/plan/route.ts) for each benchmark prompt,
// to capture the final <=15 events the app would actually show the user.
//
// Pipeline per prompt (mirrors buildPlan() exactly for the free-text semantic path):
//   1. take the prompt's TOP-80 event IDs from scripts/out/topk-events.json
//      (SEMANTIC_MATCH_COUNT = 80 in production — the exact set sent to the LLM),
//   2. fetch full event detail rows from the DB,
//   3. sort by start_time and render them as the "AVAILABLE EVENTS" list,
//   4. call openai/gpt-5-mini with the IDENTICAL system prompt, schema, and reasoningEffort,
//   5. keep only valid picks, sort by date then time, cap at MAX_ACTIVITIES = 15.
//
// ASSUMPTIONS (documented, because these prompts carry no user profile):
//   - Neutral free-text path: no interests selected (relies entirely on the prompt text),
//     no home/office (no travel filter/labels), budget "any", no weather, no busy calendar.
//   - "RIGHT NOW" is the real current time; events already started today are dropped by the LLM,
//     exactly as in production. The frozen universe is the same 7-day (jul26) window.
//
// NOTE: LLM output is not perfectly deterministic; re-runs may vary slightly.
//
// Run:
//   npx tsx --env-file=/vercel/share/.env.project scripts/llm-picks.ts
//
// Writes: scripts/out/llm-picks.json  and  scripts/out/llm-picks.csv

import { createClient } from "@supabase/supabase-js"
import { generateText, Output } from "ai"
import { z } from "zod"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

const MAX_ACTIVITIES = 15 // production cap (MAX_ACTIVITIES in route.ts)
const CURATION_MODEL = "openai/gpt-5-mini"
const TOPK_JSON = join(process.cwd(), "scripts", "out", "topk-events.json")

const EVENT_COLUMNS =
  "id,title,description,category,start_time,end_time,venue_name,address,price,neighborhood,event_url,image_url"

type EventRow = {
  id: string
  title: string
  description: string | null
  category: string | null
  start_time: string
  end_time: string | null
  venue_name: string | null
  address: string | null
  price: string | null
  neighborhood: string | null
  event_url: string | null
  image_url: string | null
}

function createServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// ---- NY-local date/time helpers (mirror route.ts) ----
function nyParts(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  const startTime = d.toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return { date, startTime }
}
function nyDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
}
function nyClockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// The next 7 calendar days (NY), used to bound displayed picks — same as upcomingDates().
function upcomingDates() {
  const out: { iso: string; weekday: string; label: string }[] = []
  const nyToday = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
  nyToday.setHours(0, 0, 0, 0)
  for (let i = 0; i < 7; i++) {
    const d = new Date(nyToday.getTime() + i * 86400000)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    out.push({
      iso,
      weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
      label: d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
    })
  }
  return out
}

// ---- Model schema (identical to route.ts) ----
const pickSchema = z.object({
  eventId: z.string().describe("the exact id of one of the provided events"),
  indoor: z.boolean(),
  neighborhood: z.string().describe("the NYC neighborhood the venue is in, inferred from its address"),
  travelFromHome: z.string(),
  travelFromOffice: z.string(),
  travelNote: z.string(),
  why: z.string().describe("one sentence on why this fits the user"),
})
const curatedSchema = z.object({
  summary: z.string(),
  picks: z.array(pickSchema),
})

async function fetchEventRows(
  supabase: ReturnType<typeof createServiceClient>,
  ids: string[],
): Promise<Map<string, EventRow>> {
  const byId = new Map<string, EventRow>()
  const ID_CHUNK = 100
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).in("id", chunk)
    if (error) throw new Error(`event fetch failed: ${error.message}`)
    for (const r of (data as EventRow[]) || []) byId.set(r.id, r)
  }
  return byId
}

async function curatePrompt(prompt: string, top80: EventRow[], nowLabel: string) {
  // Present the 80 candidates sorted by start_time (as production does), one line each.
  const sorted = [...top80].sort((a, b) => a.start_time.localeCompare(b.start_time))
  const eventLines = sorted
    .map((r) => {
      const { date, startTime } = nyParts(r.start_time)
      const endDate = r.end_time ? nyDateOf(r.end_time) : null
      const when =
        endDate && endDate !== date
          ? `${date} to ${endDate} (multi-day, available any day in range)`
          : `${date} ${startTime || "(time TBD)"}`
      return `id:${r.id} | ${when} | ${r.category || "Uncategorized"} | ${r.title} | venue: ${r.venue_name || "?"} | address: ${r.address || "?"} | price: ${r.price || "?"} | ${r.description || ""}`
    })
    .join("\n")

  // Neutral profile context (free-text-only path): no interests, no home/office, budget any.
  const context = `
RIGHT NOW it is ${nowLabel} (America/New_York). Only pick events that start AFTER this moment; never pick anything earlier today. Multi-day events already underway are fine. Plan only the next 7 days.

USER PROFILE
- Home: not provided (assume Manhattan)
- Office: not provided
- Working hours: not provided
- Interests: none selected — rely on the description below
- Max travel time one-way: no limit
- Budget: any

WEATHER FORECAST (prefer outdoor events only on outdoor-friendly days)
- No forecast available

ALREADY BUSY (do NOT pick events overlapping these)
- Calendar is open

WHAT THE USER FEELS LIKE DOING / SPECIAL REQUESTS (this is their own words — treat it as a primary signal for what to pick, and honor any constraints in it)
- ${prompt}

AVAILABLE EVENTS (choose ONLY from these — reference each by its id):
${eventLines}
`.trim()

  const curated = await generateText({
    model: CURATION_MODEL,
    experimental_output: Output.object({ schema: curatedSchema }),
    providerOptions: { openai: { reasoningEffort: "minimal" } },
    system:
      "You are an NYC concierge. From the AVAILABLE EVENTS list, choose the best ones for this user. " +
      "You MUST only reference events by an id that appears in the list — never invent events, links, dates, or venues. " +
      "STRICT RELEVANCE: only pick events that match the user's stated interests AND/OR their free-text description of what they feel like doing. If the user gave no interests, rely entirely on their description. Drop anything tangential. If few events match, pick few — it is fine to return very few or none. " +
      "Respect working hours (evenings on workdays, daytime on days off), avoid busy times, keep travel within the limit from home or office, match the weather (indoor on rainy/cold days), and honor special requests. " +
      "Favor a geographically and topically diverse set. " +
      `Pick at most ${MAX_ACTIVITIES} events, ordered by date then time. ` +
      "For each pick, infer the neighborhood from the address, estimate travel from home and office with a mode, and write one sentence on why it fits. " +
      "If nothing suitable matches, return an empty picks array and say so in the summary.",
    prompt: context,
  })
  return curated.experimental_output
}

async function main() {
  const supabase = createServiceClient()
  const dates = upcomingDates()
  const validIso = new Set(dates.map((d) => d.iso))
  const todayIso = dates[0].iso
  const nowLabel = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  const topk = JSON.parse(readFileSync(TOPK_JSON, "utf8")) as {
    results: { index: number; prompt: string; top80: string[] }[]
  }

  // Fetch detail rows for the union of all top-80 IDs across prompts (one batched read).
  const allIds = [...new Set(topk.results.flatMap((r) => r.top80))]
  const rowById = await fetchEventRows(supabase, allIds)
  console.log(`[v0] fetched ${rowById.size}/${allIds.length} event detail rows`)

  type Final = {
    index: number
    prompt: string
    inputCount: number
    diagnostics?: {
      rawPickCount: number
      droppedUnknownId: number
      droppedByDateFilter: number
      droppedAsDuplicateId: number
      droppedByCap: number
      final: number
    }
    summary: string
    picks: {
      rank: number
      eventId: string
      title: string
      category: string
      date: string
      startTime: string
      venue: string
      neighborhood: string
      why: string
    }[]
  }
  const finals: Final[] = []

  for (const r of topk.results) {
    const top80 = r.top80.map((id) => rowById.get(id)).filter((x): x is EventRow => Boolean(x))
    let out: { summary: string; picks: z.infer<typeof pickSchema>[] }
    try {
      out = await curatePrompt(r.prompt, top80, nowLabel)
    } catch (e) {
      console.log(`[v0] prompt ${r.index} curation failed:`, e instanceof Error ? e.message : e)
      finals.push({ index: r.index, prompt: r.prompt, inputCount: top80.length, summary: "(curation failed)", picks: [] })
      continue
    }

    // Map picks to authoritative rows, keep only in-window, sort by date then time, cap at 15.
    const kept = out.picks
      .map((p) => {
        const row = rowById.get(p.eventId)
        if (!row) return null
        const startDate = nyDateOf(row.start_time)
        const displayDate = startDate < todayIso ? todayIso : startDate
        const startTime = displayDate === startDate ? nyClockOf(row.start_time) : ""
        return { row, meta: p, date: displayDate, startTime }
      })
      .filter((x): x is { row: EventRow; meta: z.infer<typeof pickSchema>; date: string; startTime: string } =>
        Boolean(x),
      )
      .filter((x) => validIso.has(x.date))
      .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)))

    // Dedup by eventId: gpt-5-mini sometimes repeats the same id, which would render as
    // duplicate cards. Keep the first occurrence so the list reflects DISTINCT events shown.
    const seenIds = new Set<string>()
    const distinct = kept.filter((x) => (seenIds.has(x.row.id) ? false : (seenIds.add(x.row.id), true)))
    const capped = distinct.slice(0, MAX_ACTIVITIES)

    // Attribution diagnostics: why did the final list end up this size?
    const rawPickCount = out.picks.length // what the LLM returned
    const mappedToRow = out.picks.filter((p) => rowById.get(p.eventId)).length // ids that exist
    const afterDateFilter = kept.length // survived the "next 7 days / not earlier today" filter
    const distinctCount = distinct.length // after dedup by eventId
    const diagnostics = {
      rawPickCount,
      droppedUnknownId: rawPickCount - mappedToRow,
      droppedByDateFilter: mappedToRow - afterDateFilter,
      droppedAsDuplicateId: afterDateFilter - distinctCount,
      droppedByCap: Math.max(0, distinctCount - MAX_ACTIVITIES),
      final: capped.length,
    }

    finals.push({
      index: r.index,
      prompt: r.prompt,
      inputCount: top80.length,
      diagnostics,
      summary: out.summary,
      picks: capped.map((x, i) => ({
        rank: i + 1,
        eventId: x.row.id,
        title: x.row.title,
        category: x.row.category || "Event",
        date: x.date,
        startTime: x.startTime,
        venue: x.row.venue_name || "",
        neighborhood: x.meta.neighborhood || x.row.neighborhood || "",
        why: x.meta.why || "",
      })),
    })
    console.log(
      `[v0] ${r.index}/${topk.results.length} "${r.prompt.slice(0, 42)}" -> ${capped.length} distinct picks (raw ${out.picks.length})`,
    )
  }

  const outDir = join(process.cwd(), "scripts", "out")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, "llm-picks.json"),
    JSON.stringify({ model: CURATION_MODEL, maxActivities: MAX_ACTIVITIES, generatedAt: new Date().toISOString(), results: finals }, null, 2),
  )

  const esc = (s: string) => `"${(s ?? "").replace(/"/g, '""')}"`
  const lines = ["prompt_index,prompt,rank,event_id,title,category,date,start_time,venue,neighborhood,why"]
  for (const f of finals) {
    for (const p of f.picks) {
      lines.push(
        [
          f.index,
          esc(f.prompt),
          p.rank,
          p.eventId,
          esc(p.title),
          esc(p.category),
          p.date,
          p.startTime,
          esc(p.venue),
          esc(p.neighborhood),
          esc(p.why),
        ].join(","),
      )
    }
  }
  writeFileSync(join(outDir, "llm-picks.csv"), lines.join("\n"))
  console.log(`[v0] wrote final picks for ${finals.length} prompts to scripts/out/llm-picks.{json,csv}`)
}

main().catch((e) => {
  console.error("[v0] failed:", e)
  process.exit(1)
})
