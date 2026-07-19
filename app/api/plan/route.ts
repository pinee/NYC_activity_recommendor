import { generateText, Output } from "ai"
import { z } from "zod"
import { type WeekDay, INTEREST_KEYWORDS, INTEREST_OPTIONS } from "@/lib/types"
import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO, WORLD_CUP_CATEGORY } from "@/lib/event-sources/util"
import { geocodeAddress, estimateTravelMinutes, type Coord } from "@/lib/geo"
import { getWorldCupSpots } from "@/lib/worldcup"
import { embedQuery } from "@/lib/embeddings"

// The interest whose events are shown as location SPOTS instead of date-grouped cards.
const WORLD_CUP_INTEREST = "World Cup & Soccer"

export const maxDuration = 60

const MAX_ACTIVITIES = 15

// The one interest whose events we also match by title (holidays are categorized by
// activity type, not by the holiday name — see fetchUpcomingEvents).
const FESTIVALS_INTEREST = "Festivals & fireworks"

// Catch-all interest: matches events that match NO other interest (see fetchUpcomingEvents).
const OTHERS_INTEREST = "Others"

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
    workDays: profile.workDays,
    includeApprox: profile.includeApproximateLocations !== false,
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
  series_key: string | null
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
// Columns needed downstream (everything except the large `embedding` vector). Used when
// selecting from the semantic-search RPC so we don't ship 1536 floats per row over the wire.
const EVENT_COLUMNS =
  "id,title,description,category,start_time,end_time,venue_name,address,latitude,longitude,event_url,source,price,image_url,neighborhood,approximate_location,series_key"

// How many nearest events the semantic search returns after the hard filters are applied.
const SEMANTIC_MATCH_COUNT = 80

// Postgres extract(dow): Sunday=0 … Saturday=6. Maps profile.workDays (full weekday names).
const DOW_BY_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

// The hard filters (budget / working hours / travel / approximate location), resolved from the
// user's profile ONCE and pushed down into the SQL search functions so they run BEFORE the
// semantic fetch and the LLM ranking — never after.
type EventFilters = {
  budgetCap: number | null // max acceptable price in USD (null = no cap)
  includeApprox: boolean // keep events whose coordinates are only estimated?
  homeLat: number | null
  homeLng: number | null
  officeLat: number | null
  officeLng: number | null
  maxTravel: number | null // max one-way minutes from the closer of home/office
  workdayDows: number[] // work days as Postgres dow ints
  workStartMin: number | null // work start, minutes since midnight (NY)
  workEndMin: number | null // work end, minutes since midnight (NY)
}

// Build the candidate event pool for the next 7 days, combining up to two retrieval paths:
//
//   A. INTEREST KEYWORDS — the category-based filter used when the user selected interests.
//   B. SEMANTIC SEARCH — when the user typed a free-text description of what they feel like
//      doing, we embed it and pull the closest events by cosine similarity (match_events()).
//      This is what lets someone get relevant recommendations WITHOUT selecting any interest.
//
// BOTH paths now apply the hard filters (budget / hours / travel / approximate location) IN SQL,
// so only events the user can actually attend are ever fetched, embedded-ranked, or sent to the
// LLM. When both are provided the two result sets are UNIONED (deduped by id). If neither is
// usable (no interests, embedding failed) we return the whole filtered week's window.
async function fetchUpcomingEvents(
  interests: string[],
  queryText: string,
  filters: EventFilters,
): Promise<EventRow[]> {
  const supabase = createServiceClient()
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const windowStartISO = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  const windowEndISO = new Date(new Date(windowStartISO).getTime() + 7 * 86400000).toISOString()

  // Filter args shared by BOTH search functions (identical parameter names in SQL).
  const filterArgs = {
    p_window_start: windowStartISO,
    p_window_end: windowEndISO,
    p_budget_cap: filters.budgetCap,
    p_include_approx: filters.includeApprox,
    p_home_lat: filters.homeLat,
    p_home_lng: filters.homeLng,
    p_office_lat: filters.officeLat,
    p_office_lng: filters.officeLng,
    p_max_travel: filters.maxTravel,
    p_workday_dows: filters.workdayDows,
    p_work_start_min: filters.workStartMin,
    p_work_end_min: filters.workEndMin,
  }

  const byId = new Map<string, EventRow>()

  // ---- Path A: interest keyword filter (category-based) ----
  //
  // Holiday/festival events are the exception: sources almost always categorize them by
  // activity type ("Concerts", "Nature Programs", "America250", "Arts & Culture"), not by
  // the holiday — so a July-4 concert or a Pride festival would never match on category.
  // For the "Festivals & fireworks" interest we therefore ALSO match on the event title.
  //
  // "Others" is a catch-all with no keywords of its own: it matches events that match NO
  // other interest — expressed as an exclusion list over the FULL keyword universe. All of
  // this is passed to filter_events() as %-wrapped ILIKE pattern arrays.
  const selectableInterests = interests.filter((i) => i !== OTHERS_INTEREST)
  const keywords = interestKeywords(selectableInterests)
  const wantsOthers = interests.includes(OTHERS_INTEREST)
  const hasInterestFilter = keywords.length > 0 || wantsOthers
  const festivalKeywords = INTEREST_KEYWORDS[FESTIVALS_INTEREST] ?? []

  if (hasInterestFilter) {
    const universe = interestKeywords(INTEREST_OPTIONS.filter((i) => i !== OTHERS_INTEREST))
    const { data, error } = await supabase
      .rpc("filter_events", {
        ...filterArgs,
        p_limit: 500,
        p_no_keyword: false,
        p_cat_patterns: keywords.map((k) => `%${k}%`),
        p_title_patterns: selectableInterests.includes(FESTIVALS_INTEREST)
          ? festivalKeywords.map((k) => `%${k}%`)
          : [],
        p_others: wantsOthers,
        p_exclude_cat_patterns: universe.map((k) => `%${k}%`),
        p_exclude_title_patterns: festivalKeywords.map((k) => `%${k}%`),
      })
      .select(EVENT_COLUMNS)
    if (error) throw new Error(error.message)
    for (const r of (data as unknown as EventRow[]) || []) byId.set(r.id, r)
  }

  // ---- Path B: semantic search over the free-text description ----
  if (queryText.trim()) {
    const embedding = await embedQuery(queryText)
    if (embedding) {
      const { data, error } = await supabase
        .rpc("match_events", {
          p_query_embedding: embedding,
          p_match_count: SEMANTIC_MATCH_COUNT,
          ...filterArgs,
        })
        .select(EVENT_COLUMNS)
      if (error) throw new Error(error.message)
      for (const r of (data as unknown as EventRow[]) || []) byId.set(r.id, r)
    }
  }

  // ---- Path C: nothing usable → the whole (still filtered) window ----
  if (byId.size === 0 && !hasInterestFilter && !queryText.trim()) {
    const { data, error } = await supabase
      .rpc("filter_events", {
        ...filterArgs,
        p_limit: 500,
        p_no_keyword: true,
        p_cat_patterns: [],
        p_title_patterns: [],
        p_others: false,
        p_exclude_cat_patterns: [],
        p_exclude_title_patterns: [],
      })
      .select(EVENT_COLUMNS)
    if (error) throw new Error(error.message)
    for (const r of (data as unknown as EventRow[]) || []) byId.set(r.id, r)
  }

  // The "already started today" cutoff and all hard filters were applied in SQL, so just
  // time-order the combined pool and keep it bounded for the model.
  const rows = [...byId.values()]
  rows.sort((a, b) => a.start_time.localeCompare(b.start_time))
  return rows.slice(0, 500)
}

// The search functions return ONE representative occurrence per series (the earliest/closest),
// so a recurring show made of separate per-night rows only knows its own single date. To render
// the "Runs through …" range correctly we look up the true span of each picked series — the
// earliest start and latest end across ALL of its occurrences (still-relevant ones). For a
// single spanning row this simply echoes its own start/end; for per-night series it recovers the
// full run so an event that began in a prior week and is still running shows its real end date.
async function fetchSeriesSpans(
  seriesKeys: string[],
): Promise<Map<string, { start: string; end: string | null }>> {
  const out = new Map<string, { start: string; end: string | null }>()
  const keys = [...new Set(seriesKeys.filter(Boolean))]
  if (keys.length === 0) return out
  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()
  // Only occurrences that haven't fully finished, so a long-past first night doesn't matter and
  // the latest end reflects when the run actually stops.
  const { data, error } = await supabase
    .from("events")
    .select("series_key,start_time,end_time")
    .in("series_key", keys)
    .or(`end_time.gte.${nowISO},and(end_time.is.null,start_time.gte.${nowISO})`)
  if (error || !data) return out
  for (const r of data as { series_key: string | null; start_time: string; end_time: string | null }[]) {
    if (!r.series_key) continue
    const prev = out.get(r.series_key)
    const end = r.end_time ?? r.start_time
    if (!prev) {
      out.set(r.series_key, { start: r.start_time, end })
    } else {
      out.set(r.series_key, {
        start: r.start_time < prev.start ? r.start_time : prev.start,
        end: prev.end === null || end > prev.end ? end : prev.end,
      })
    }
  }
  return out
}

// ---- Filter helpers ----

// Map the user's budget preference to a maximum acceptable price (null = no cap).
// Mirrors public.parse_price_usd() semantics on the SQL side.
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
  const interests: string[] = profile.interests || []
  // The user's free-text description of what they feel like doing (the repurposed "special
  // requests"). Drives semantic search when no interests are selected, and is always handed
  // to the model as intent to honor.
  const queryText: string = (requests || [])
    .map((r: any) => (r?.text || "").trim())
    .filter(Boolean)
    .join(". ")
    .trim()

  // World Cup viewing is location-first, not date-first (fans already know match times), so
  // when the user selects that interest we surface it as aggregated viewing SPOTS with date
  // spans — never as date-grouped activity cards. Fetched via the same helper the standalone
  // browse endpoint uses, so the two always agree.
  const worldCup = interests.includes(WORLD_CUP_INTEREST) ? await getWorldCupSpots(profile) : undefined

  // Geocode home/office ONCE, up front, so the hard filters (travel especially) can run in
  // SQL before the fetch. Also reused later for the travel-time display labels. Best-effort:
  // if geocoding fails the coords are null and the travel filter is simply skipped.
  const [homeCoord, officeCoord] = await Promise.all([
    geocodeAddress(profile.homeAddress),
    geocodeAddress(profile.officeAddress),
  ])

  // Resolve every hard filter from the profile, to be pushed into the SQL search functions.
  const filters: EventFilters = {
    budgetCap: budgetCapUSD(profile.budget),
    includeApprox: profile.includeApproximateLocations !== false,
    homeLat: homeCoord?.lat ?? null,
    homeLng: homeCoord?.lng ?? null,
    officeLat: officeCoord?.lat ?? null,
    officeLng: officeCoord?.lng ?? null,
    maxTravel: typeof profile.maxTravelMinutes === "number" ? profile.maxTravelMinutes : null,
    workdayDows: ((profile.workDays as string[]) || [])
      .map((d) => DOW_BY_NAME[(d || "").toLowerCase()])
      .filter((n): n is number => typeof n === "number"),
    workStartMin: clockToMinutes(profile.workStart),
    workEndMin: clockToMinutes(profile.workEnd),
  }

  // 1) Read the catalog from the database (no live web search). The hard filters are applied
  //    IN SQL here, so only attendable events come back — via the interest keyword filter
  //    and/or semantic search over the user's free-text description.
  const allRows = await fetchUpcomingEvents(interests, queryText, filters)
  // Keep World Cup events out of the date-grouped list — they're shown as spots above, so
  // including them here would both duplicate them and reintroduce the date-level display.
  const rows = allRows.filter((r) => r.category !== WORLD_CUP_CATEGORY)

  if (rows.length === 0) {
    return {
      summary:
        worldCup && worldCup.spots.length > 0
          ? "World Cup & soccer viewing is location-based — here are all the spots across NYC where you can catch the matches."
          : "No events are in the catalog yet. The daily ingestion job collects fresh NYC events each morning — please check back soon.",
      activities: [],
      sources: [],
      worldCup,
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

  const nowLabel = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  const context = `
RIGHT NOW it is ${nowLabel} (America/New_York). Only pick events that start AFTER this moment; never pick anything earlier today. Multi-day events already underway are fine. Plan only the next 7 days.
TODAY is ${dates[0].label}.

USER PROFILE
- Home: ${profile.homeAddress || "not provided (assume Manhattan)"}
- Office: ${profile.officeAddress || "not provided"}
- Working hours: ${profile.workStart}–${profile.workEnd} on ${(profile.workDays || []).join(", ") || "weekdays"}
- Interests: ${(profile.interests || []).join(", ") || "none selected — rely on the description below"}
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

WHAT THE USER FEELS LIKE DOING / SPECIAL REQUESTS (this is their own words — treat it as a primary signal for what to pick, and honor any constraints in it)
${(requests || []).map((r: any) => `- ${r.text}`).join("\n") || "- Nothing specified"}

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
        "STRICT RELEVANCE: only pick events that match the user's stated interests AND/OR their free-text description of what they feel like doing. If the user gave no interests, rely entirely on their description. Drop anything tangential. If few events match, pick few — it is fine to return very few or none. " +
        "Respect working hours (evenings on workdays, daytime on days off), avoid busy times, keep travel within the limit from home or office, match the weather (indoor on rainy/cold days), and honor special requests. " +
        "Favor a geographically and topically diverse set. " +
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
    // With no interests selected the rows are already the semantic-search results for the
    // user's description (relevance-ordered by the embedding), so keep them as-is.
    const hasInterests = interests.length > 0
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
          why: hasInterests && r.category ? `Matches your interest in ${r.category}.` : "",
        },
      }))
    const basis = hasInterests ? "your interests" : "your description"
    summary =
      picks.length > 0
        ? `Here are upcoming NYC events from the catalog that match ${basis}, sorted by date. (Smart ranking was temporarily unavailable.)`
        : "No catalog events matched your interests or description for the next 7 days. Try adding an interest, rephrasing what you feel like doing, or check back after the next daily update."
  }

  const validIso = new Set(dates.map((d) => d.iso))
  const weekdayByIso = new Map(dates.map((d) => [d.iso, d.weekday as WeekDay]))
  const todayIso = dates[0].iso

  // Recover the true run span for each picked series (see fetchSeriesSpans). Needed so that
  // recurring shows stored as separate per-night rows get an accurate "Runs through" end date,
  // not just the single representative night the search function returned.
  const seriesSpans = await fetchSeriesSpans(picks.map((p) => p.row.series_key).filter((k): k is string => !!k))

  // 3) Merge curation with authoritative DB fields. DB owns title/date/url/price; meta owns
  //    why/travel/etc. The hard filters (budget / hours / travel / approximate location) were
  //    already applied in SQL before the fetch, so there is no post-LLM filtering here — we
  //    only compute the straight-line travel estimates used for the display labels.
  const kept = picks
    .map(({ row, meta }) => {
      // Prefer the whole-series span over the single representative occurrence, so recurring
      // per-night shows report the full run (start of the run through the last performance).
      const span = row.series_key ? seriesSpans.get(row.series_key) : undefined
      const startSource = span?.start ?? row.start_time
      const endSource = span?.end ?? row.end_time
      const startDate = nyDateOf(startSource)
      const endDate = endSource ? nyDateOf(endSource) : null
      const multiDay = !!endDate && endDate !== startDate
      // Ongoing events started before today are anchored to today so they still
      // surface in the week view; otherwise we use their real start day.
      const displayDate = startDate < todayIso ? todayIso : startDate
      const isOpeningDay = displayDate === startDate
      // Show a clock time only on the event's actual start day. For ongoing days we
      // rely on the "Runs through" range label instead. End time only for single-day.
      const startTime = isOpeningDay ? nyClockOf(startSource) : ""
      const endTime = !multiDay && endSource ? nyClockOf(endSource) : ""

      // Travel-time display estimate (SQL already enforced the max-travel filter).
      let detHome: number | null = null
      let detOffice: number | null = null
      const eventCoord: Coord | null =
        typeof row.latitude === "number" && typeof row.longitude === "number"
          ? { lat: row.latitude, lng: row.longitude }
          : null
      if (eventCoord) {
        if (homeCoord) detHome = estimateTravelMinutes(homeCoord, eventCoord)
        if (officeCoord) detOffice = estimateTravelMinutes(officeCoord, eventCoord)
      }

      return {
        row,
        meta,
        date: displayDate,
        endDate,
        startTime,
        endTime,
        weekday: weekdayByIso.get(displayDate),
        detHome,
        detOffice,
      }
    })
    // Defensive: only show events that fall within the next 7 days.
    .filter((x) => validIso.has(x.date))

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

  return { summary, activities, sources, worldCup }
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
