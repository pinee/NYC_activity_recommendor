import { generateText, Output } from "ai"
import { z } from "zod"
import { WEEK_DAYS } from "@/lib/types"
import { createServiceClient } from "@/lib/supabase/server"

export const maxDuration = 60

const MAX_ACTIVITIES = 15

// ---- Date helpers (anchored to America/New_York) ----

// The next 7 calendar days starting today, each with ISO date, weekday, and a label.
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

// Convert a stored UTC timestamp into NYC-local date (YYYY-MM-DD), weekday, and 24h start time.
function nyParts(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) // YYYY-MM-DD
  const weekday = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" })
  const startTime = d.toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return { date, weekday, startTime }
}

// ---- Short-lived in-memory cache (per warm server instance) ----
type CacheEntry = { expires: number; payload: unknown }
const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

function cacheKey(profile: any, requests: any, weekStart: string) {
  return JSON.stringify({
    week: weekStart,
    interests: [...(profile.interests || [])].sort(),
    home: profile.homeAddress || "",
    office: profile.officeAddress || "",
    travel: profile.maxTravelMinutes,
    budget: profile.budget,
    diversity: profile.diversity,
    workDays: profile.workDays,
    requests: (requests || []).map((r: any) => r.text),
  })
}

// ---- Database read ----

type EventRow = {
  id: string
  title: string
  description: string | null
  category: string | null
  date_time: string
  venue: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  url: string | null
  source: string | null
  price: string | null
}

// Fetch all events stored for the next 7 days (rolling window from now).
async function fetchUpcomingEvents(): Promise<EventRow[]> {
  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()
  const endISO = new Date(Date.now() + 7 * 86400000).toISOString()
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .gte("date_time", nowISO)
    .lte("date_time", endISO)
    .order("date_time", { ascending: true })
    .limit(200)
  if (error) throw new Error(error.message)
  return (data as EventRow[]) || []
}

// Metadata the model adds on top of an authoritative DB event.
type PickMeta = {
  indoor: boolean
  neighborhood: string
  travelFromHome: string
  travelFromOffice: string
  travelNote: string
  why: string
}

function tokenize(s: string): string[] {
  return (s || "").toLowerCase().match(/[a-z]+/g) || []
}

// Deterministic interest match used when the AI curator is unavailable:
// keep an event if its category shares any word with one of the user's interests.
function matchesInterest(category: string | null, interests: string[]): boolean {
  if (!interests.length) return true
  const catTokens = new Set(tokenize(category))
  if (catTokens.size === 0) return false
  return interests.some((it) => tokenize(it).some((t) => t.length >= 3 && catTokens.has(t)))
}

// ---- Model output: the model only CURATES events by id; it never invents links or dates ----
const pickSchema = z.object({
  eventId: z.string().describe("the exact id of one of the provided events"),
  indoor: z.boolean(),
  neighborhood: z.string().describe("the NYC neighborhood the venue is in, inferred from its address"),
  travelFromHome: z
    .string()
    .describe("estimated one-way travel from the user's home with mode, e.g. '~25 min by subway'; empty if unknown"),
  travelFromOffice: z
    .string()
    .describe("estimated one-way travel from the user's office with mode, e.g. '~15 min walk'; empty if unknown"),
  travelNote: z.string().describe("short note about travel"),
  why: z.string().describe("one sentence on why this fits the user"),
})

const curatedSchema = z.object({
  summary: z.string().describe("2-3 sentence overview of the week's plan"),
  picks: z.array(pickSchema),
})

async function buildPlan(body: any) {
  const { profile, weather, events: busy, requests } = body
  const dates = upcomingDates()

  // 1) Read the catalog from the database (no live web search).
  const rows = await fetchUpcomingEvents()

  if (rows.length === 0) {
    return {
      summary:
        "No events are in the catalog yet. The daily ingestion job collects fresh NYC events each morning — please check back soon.",
      activities: [],
      sources: [],
    }
  }

  // Index events by id and present them to the model with NYC-local date/time precomputed.
  const byId = new Map(rows.map((r) => [r.id, r]))
  const eventLines = rows
    .map((r) => {
      const { date, startTime } = nyParts(r.date_time)
      return `id:${r.id} | ${date} ${startTime || "(time TBD)"} | ${r.category || "Uncategorized"} | ${r.title} | venue: ${r.venue || "?"} | address: ${r.address || "?"} | price: ${r.price || "?"} | ${r.description || ""}`
    })
    .join("\n")

  const context = `
TODAY is ${dates[0].label}. Plan only the next 7 days.

USER PROFILE
- Home: ${profile.homeAddress || "not provided (assume Manhattan)"}
- Office: ${profile.officeAddress || "not provided"}
- Working hours: ${profile.workStart}–${profile.workEnd} on ${(profile.workDays || []).join(", ") || "weekdays"}
- Interests: ${(profile.interests || []).join(", ") || "general culture"}
- Variety preference (1=stick to favorites, 5=lots of variety): ${profile.diversity}
- Max travel time one-way: ${profile.maxTravelMinutes} minutes
- Budget: ${profile.budget}

WEATHER FORECAST (prefer outdoor events only on outdoor-friendly days)
${(weather || [])
  .map(
    (w: any) =>
      `- ${w.day} ${w.label}: ${w.condition}, ${w.low}–${w.high}°F, ${w.precipProbability}% precip, ${w.outdoorFriendly ? "outdoor-friendly" : "better indoors"}`,
  )
  .join("\n") || "- No forecast available"}

ALREADY BUSY (do NOT pick events overlapping these)
${(busy || []).map((e: any) => `- ${e.day} ${e.start}–${e.end}: ${e.title}`).join("\n") || "- Calendar is open"}

SPECIAL REQUESTS (honor these)
${(requests || []).map((r: any) => `- ${r.text}`).join("\n") || "- None"}

AVAILABLE EVENTS (choose ONLY from these — reference each by its id):
${eventLines}
`.trim()

  // 2) Curate the catalog into a personalized plan. The AI ranking is best-effort: if it is
  //    unavailable (e.g. rate limited), we fall back to a deterministic interest match so the
  //    database can always serve a plan on its own.
  let summary: string
  let picks: { row: EventRow; meta: PickMeta }[]

  try {
    const curated = await generateText({
      model: "openai/gpt-5-mini",
      experimental_output: Output.object({ schema: curatedSchema }),
      providerOptions: { openai: { reasoningEffort: "minimal" } },
      system:
        "You are an NYC concierge. From the AVAILABLE EVENTS list, choose the best ones for this user. " +
        "You MUST only reference events by an id that appears in the list — never invent events, links, dates, or venues. " +
        "STRICT RELEVANCE: only pick events that directly belong to one of the user's stated interest categories. Drop anything tangential. If few events match, pick few — it is fine to return very few or none. " +
        "Respect working hours (evenings on workdays, daytime on days off), avoid busy times, keep travel within the limit from home or office, match the weather (indoor on rainy/cold days), and honor special requests. " +
        "Favor a geographically and topically diverse set per the variety preference. " +
        `Pick at most ${MAX_ACTIVITIES} events, ordered by date then time. ` +
        "For each pick, infer the neighborhood from the address, estimate travel from home and office with a mode, and write one sentence on why it fits. " +
        "If nothing suitable matches, return an empty picks array and say so in the summary.",
      prompt: context,
    })
    summary = curated.experimental_output.summary
    picks = curated.experimental_output.picks
      .map((p) => {
        const r = byId.get(p.eventId)
        return r
          ? {
              row: r,
              meta: {
                indoor: p.indoor,
                neighborhood: p.neighborhood,
                travelFromHome: p.travelFromHome,
                travelFromOffice: p.travelFromOffice,
                travelNote: p.travelNote,
                why: p.why,
              },
            }
          : null
      })
      .filter((x): x is { row: EventRow; meta: PickMeta } => Boolean(x))
  } catch (err) {
    // AI curator unavailable — serve the catalog directly with a deterministic interest filter.
    console.log("[v0] curation unavailable, using deterministic fallback:", err instanceof Error ? err.message : err)
    const interests = profile.interests || []
    picks = rows
      .filter((r) => matchesInterest(r.category, interests))
      .map((r) => ({
        row: r,
        meta: {
          indoor: false,
          neighborhood: "",
          travelFromHome: "",
          travelFromOffice: "",
          travelNote: "",
          why: r.category ? `Matches your interest in ${r.category}.` : "",
        },
      }))
    summary =
      picks.length > 0
        ? "Here are upcoming NYC events from the catalog that match your interests, sorted by date. (Smart ranking was temporarily unavailable.)"
        : "No catalog events matched your interests for the next 7 days. Try adding more interests or check back after the next daily update."
  }

  const validIso = new Set(dates.map((d) => d.iso))

  // 3) Merge curation with authoritative DB fields. DB owns title/date/url/price; meta owns why/travel/etc.
  const activities = picks
    .map(({ row, meta }) => {
      const { date, weekday, startTime } = nyParts(row.date_time)
      return { row, meta, date, weekday: weekday as (typeof WEEK_DAYS)[number], startTime }
    })
    // Defensive: only show events that fall within the next 7 days.
    .filter((x) => validIso.has(x.date))
    .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)))
    .slice(0, MAX_ACTIVITIES)
    .map((x, i) => ({
      id: `act-${i}`,
      title: x.row.title,
      category: x.row.category || "Event",
      date: x.date,
      day: x.weekday,
      startTime: x.startTime,
      endTime: "",
      venue: x.row.venue || "",
      neighborhood: x.meta.neighborhood || "",
      address: x.row.address || "",
      priceLabel: x.row.price || "",
      indoor: x.meta.indoor,
      url: x.row.url || "",
      why: x.meta.why || "",
      travelNote: x.meta.travelNote || "",
      travelFromHome: x.meta.travelFromHome || "",
      travelFromOffice: x.meta.travelFromOffice || "",
    }))

  // Build a de-duplicated source list from the events actually shown.
  const sources = Array.from(
    new Map(
      activities
        .filter((a) => a.url)
        .map((a) => {
          let host = ""
          try {
            host = new URL(a.url).hostname.replace(/^www\./, "")
          } catch {
            host = a.url
          }
          const row = rows.find((r) => r.url === a.url)
          return [host, { title: row?.source || host, url: a.url, host }]
        }),
    ).values(),
  )

  return { summary, activities, sources }
}

export async function POST(req: Request) {
  const body = await req.json()
  const dates = upcomingDates()
  const key = cacheKey(body.profile || {}, body.requests, dates[0].iso)

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
      try {
        // Serve from cache instantly when available
        const cached = CACHE.get(key)
        if (cached && cached.expires > Date.now()) {
          send({ type: "status", message: "Loading your saved plan…" })
          send({ type: "result", ...(cached.payload as object), cached: true })
          controller.close()
          return
        }

        send({ type: "status", message: "Reading the latest NYC events…" })
        const payload = await buildPlan(body)

        send({ type: "status", message: "Organizing your week…" })
        CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, payload })
        send({ type: "result", ...payload })
        controller.close()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.log("[v0] plan generation error:", message)

        const rateLimited = /rate-?limit|too many requests|free tier|paid credits|429/i.test(message)
        const needsBilling = /credit card|payment method/i.test(message)

        let error = "Could not generate your plan. Please try again."
        let code = "error"
        if (rateLimited) {
          error =
            "Your AI Gateway free-tier limit was hit. Wait a minute and try again, or add paid credits in your Vercel AI Gateway settings for unrestricted use."
          code = "rate_limit"
        } else if (needsBilling) {
          error =
            "AI Gateway needs a payment method before it can organize your plan. Add a credit card to your Vercel account to unlock your free AI credits, then try again."
          code = "billing"
        }
        send({ type: "error", error, code })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
