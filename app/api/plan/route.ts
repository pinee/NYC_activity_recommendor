import { generateText, Output } from "ai"
import { z } from "zod"
import { type WeekDay, INTEREST_KEYWORDS } from "@/lib/types"
import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { geocodeAddress, estimateTravelMinutes, type Coord } from "@/lib/geo"

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

// NYC-local calendar date (YYYY-MM-DD) from a UTC timestamp.
function nyDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
}

// NYC-local 24h clock (HH:MM) from a UTC timestamp.
function nyClockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
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
  start_time: string
  end_time: string | null
  venue_name: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  event_url: string | null
  source: string | null
  price: string | null
  image_url: string | null
  neighborhood: string | null
  approximate_location: boolean | null
}

// Build the set of category keywords for the user's interests (deduped, lowercased).
function interestKeywords(interests: string[]): string[] {
  const set = new Set<string>()
  for (const it of interests) {
    const kws = INTEREST_KEYWORDS[it] || tokenize(it).filter((t) => t.length >= 3)
    for (const k of kws) set.add(k.toLowerCase())
  }
  return [...set]
}

// Fetch events whose span overlaps the next 7 days (rolling window from the start of
// today, NY time), PRE-FILTERED to the user's interests so the (capped) result set is
// always relevant rather than just "the earliest N events". This includes ongoing
// multi-day events that began earlier: an event is in-window if it starts on/before the
// window end AND it either ends on/after the window start, or (single-day) starts after it.
async function fetchUpcomingEvents(interests: string[]): Promise<EventRow[]> {
  const supabase = createServiceClient()
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const windowStartISO = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  const windowEndISO = new Date(new Date(windowStartISO).getTime() + 7 * 86400000).toISOString()

  let query = supabase
    .from("events")
    .select("*")
    .lte("start_time", windowEndISO)
    .or(`end_time.gte.${windowStartISO},and(end_time.is.null,start_time.gte.${windowStartISO})`)

  // Category pre-filter: keep only events whose category matches an interest keyword.
  // When no interests are set, fall through and return the whole window.
  const keywords = interestKeywords(interests)
  if (keywords.length > 0) {
    query = query.or(keywords.map((k) => `category.ilike.%${k}%`).join(","))
  }

  const { data, error } = await query.order("start_time", { ascending: true }).limit(500)
  if (error) throw new Error(error.message)
  return (data as EventRow[]) || []
}

// ---- Deterministic filter helpers (budget / working hours / travel) ----

// Parse a free-text price into the cheapest dollar figure it implies.
// "Free" -> 0, "$25" -> 25, "$10–$40" -> 10 (lowest), unknown/blank -> null (can't judge).
function parsePriceUSD(price: string | null): number | null {
  if (!price) return null
  const text = price.toLowerCase()
  if (text.includes("free") || text.includes("no charge")) return 0
  const nums = (price.match(/\d+(?:\.\d+)?/g) || []).map(Number)
  if (nums.length === 0) return null
  return Math.min(...nums)
}

// Map the user's budget preference to a maximum acceptable price (null = no cap).
function budgetCapUSD(budget: string): number | null {
  switch (budget) {
    case "free":
      return 0
    case "low":
      return 25
    case "medium":
      return 75
    default:
      return null // "any"
  }
}

// "HH:MM" -> minutes since midnight (for working-hours comparisons).
function clockToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "")
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
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

function tokenize(s: string | null): string[] {
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

  // 1) Read the catalog from the database (no live web search), pre-filtered to interests.
  const rows = await fetchUpcomingEvents(profile.interests || [])

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
      const { date, startTime } = nyParts(r.start_time)
      const endDate = r.end_time ? nyDateOf(r.end_time) : null
      // Multi-day events show a range and are flagged as available any day in that span.
      const when =
        endDate && endDate !== date
          ? `${date} to ${endDate} (multi-day, available any day in range)`
          : `${date} ${startTime || "(time TBD)"}`
      return `id:${r.id} | ${when} | ${r.category || "Uncategorized"} | ${r.title} | venue: ${r.venue_name || "?"} | address: ${r.address || "?"} | price: ${r.price || "?"} | ${r.description || ""}`
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
  const weekdayByIso = new Map(dates.map((d) => [d.iso, d.weekday as WeekDay]))
  const todayIso = dates[0].iso

  // Geocode home/office once for deterministic travel filtering (free, cached, best-effort).
  const [homeCoord, officeCoord] = await Promise.all([
    geocodeAddress(profile.homeAddress),
    geocodeAddress(profile.officeAddress),
  ])

  // Deterministic constraints, applied AFTER the AI has chosen relevant events.
  const cap = budgetCapUSD(profile.budget)
  const maxTravel = typeof profile.maxTravelMinutes === "number" ? profile.maxTravelMinutes : null
  const workStartMin = clockToMinutes(profile.workStart)
  const workEndMin = clockToMinutes(profile.workEnd)
  const workDays: string[] = profile.workDays || []
  // Default to including approximate-location events unless the user opts out.
  const includeApproximate = profile.includeApproximateLocations !== false
  const removed = { budget: 0, hours: 0, travel: 0, approx: 0 }

  // 3) Merge curation with authoritative DB fields. DB owns title/date/url/price; meta owns why/travel/etc.
  const enriched = picks
    .map(({ row, meta }) => {
      const startDate = nyDateOf(row.start_time)
      const endDate = row.end_time ? nyDateOf(row.end_time) : null
      const multiDay = !!endDate && endDate !== startDate
      // Ongoing events started before today are anchored to today so they still
      // surface in the week view; otherwise we use their real start day.
      const displayDate = startDate < todayIso ? todayIso : startDate
      const isOpeningDay = displayDate === startDate
      // Show a clock time only on the event's actual start day. For ongoing days we
      // rely on the "Runs through" range label instead. End time only for single-day.
      const startTime = isOpeningDay ? nyClockOf(row.start_time) : ""
      const endTime = !multiDay && row.end_time ? nyClockOf(row.end_time) : ""
      return { row, meta, date: displayDate, endDate, startTime, endTime, weekday: weekdayByIso.get(displayDate) }
    })
    // Defensive: only show events that fall within the next 7 days.
    .filter((x) => validIso.has(x.date))

  // 4) Apply the deterministic budget / working-hours / travel filters.
  const kept: (typeof enriched[number] & { detHome: number | null; detOffice: number | null })[] = []
  for (const x of enriched) {
    // Approximate location: when the user opts out, drop events whose coordinates are
    // only an approximation (neighborhood/org centroid or geocoded), since their travel
    // times can't be trusted.
    if (!includeApproximate && x.row.approximate_location) {
      removed.approx++
      continue
    }

    // Budget: drop only when we can parse a price AND it exceeds the cap. Unknown/free pass.
    if (cap !== null) {
      const priceUSD = parsePriceUSD(x.row.price)
      if (priceUSD !== null && priceUSD > cap) {
        removed.budget++
        continue
      }
    }

    // Working hours: drop events that start during the user's working hours on a workday.
    if (x.startTime && x.weekday && workDays.includes(x.weekday) && workStartMin !== null && workEndMin !== null) {
      const startMin = clockToMinutes(x.startTime)
      if (startMin !== null && startMin >= workStartMin && startMin < workEndMin) {
        removed.hours++
        continue
      }
    }

    // Travel: estimate one-way minutes from home and office (straight-line). Keep the
    // closer of the two. Only filter when we have BOTH an event location and an origin.
    let detHome: number | null = null
    let detOffice: number | null = null
    const eventCoord: Coord | null =
      typeof x.row.latitude === "number" && typeof x.row.longitude === "number"
        ? { lat: x.row.latitude, lng: x.row.longitude }
        : null
    if (eventCoord) {
      if (homeCoord) detHome = estimateTravelMinutes(homeCoord, eventCoord)
      if (officeCoord) detOffice = estimateTravelMinutes(officeCoord, eventCoord)
    }
    const bestTravel = [detHome, detOffice].filter((n): n is number => n !== null).sort((a, b) => a - b)[0] ?? null
    if (maxTravel !== null && bestTravel !== null && bestTravel > maxTravel) {
      removed.travel++
      continue
    }

    kept.push({ ...x, detHome, detOffice })
  }

  const activities = kept
    .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)))
    .slice(0, MAX_ACTIVITIES)
    .map((x, i) => ({
      id: `act-${i}`,
      title: x.row.title,
      category: x.row.category || "Event",
      date: x.date,
      day: x.weekday ?? ("Monday" as WeekDay),
      startTime: x.startTime,
      endTime: x.endTime,
      endDate: x.endDate ?? "",
      venue: x.row.venue_name || "",
      neighborhood: x.meta.neighborhood || x.row.neighborhood || "",
      address: x.row.address || "",
      priceLabel: x.row.price || "",
      indoor: x.meta.indoor,
      url: x.row.event_url || "",
      imageUrl: x.row.image_url || "",
      why: x.meta.why || "",
      travelNote: x.meta.travelNote || "",
      // Prefer the deterministic straight-line estimate; fall back to the AI's text.
      travelFromHome: x.detHome !== null ? `~${x.detHome} min` : x.meta.travelFromHome || "",
      travelFromOffice: x.detOffice !== null ? `~${x.detOffice} min` : x.meta.travelFromOffice || "",
      approximateLocation: x.row.approximate_location ?? false,
    }))

  // Note describing what the deterministic filters removed (shown to the user).
  const totalRemoved = removed.budget + removed.hours + removed.travel + removed.approx
  let filteredNote = ""
  if (totalRemoved > 0) {
    const parts: string[] = []
    if (removed.travel) parts.push(`${removed.travel} too far`)
    if (removed.budget) parts.push(`${removed.budget} over budget`)
    if (removed.hours) parts.push(`${removed.hours} during working hours`)
    if (removed.approx) parts.push(`${removed.approx} with approximate locations`)
    filteredNote = `${totalRemoved} ${totalRemoved === 1 ? "event" : "events"} hidden: ${parts.join(", ")}.`
  }

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
          const row = rows.find((r) => r.event_url === a.url)
          return [host, { title: row?.source || host, url: a.url, host }]
        }),
    ).values(),
  )

  return { summary, activities, sources, filteredNote: filteredNote || undefined }
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
