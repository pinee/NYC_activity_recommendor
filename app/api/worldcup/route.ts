import { WORLD_CUP_CATEGORY } from "@/lib/event-sources/util"
import { createServiceClient } from "@/lib/supabase/server"
import { geocodeAddress, estimateTravelMinutes, type Coord } from "@/lib/geo"
import type { Activity, WeekDay, WeeklyPlan } from "@/lib/types"

export const maxDuration = 30

// ---- NYC-local date/time helpers (mirrors the plan route) ----

function nyDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
}

function nyWeekdayOf(iso: string): WeekDay {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  }) as WeekDay
}

function nyClockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// Best-effort indoor/outdoor guess for display. Fan zones, parks, and big-screen
// screenings are outdoor; bars, pubs, lounges, cinemas, and rooftops read as indoor.
function guessIndoor(title: string | null, venue: string | null, description: string | null): boolean {
  const t = `${title || ""} ${venue || ""} ${description || ""}`.toLowerCase()
  if (/\b(fan zone|fan village|big screen|park|plaza|outdoor|waterfront|pier|rooftop)\b/.test(t)) return false
  if (/\b(bar|pub|tavern|lounge|club|cinema|theater|theatre|indoor|hall|restaurant|social)\b/.test(t)) return true
  return false
}

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

// Fetch EVERY World Cup viewing event that hasn't finished yet — the whole tournament, not
// the 7-day planner window. No AI curation, no diversity de-duplication, no activity cap:
// this is a complete browse of the catalog for the "World Cup & Soccer" interest.
async function fetchAllWorldCup(): Promise<EventRow[]> {
  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()

  // Keep anything still upcoming or ongoing: end_time in the future, or (no end_time)
  // start_time in the future. Ordered chronologically.
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("category", WORLD_CUP_CATEGORY)
    .or(`end_time.gte.${nowISO},and(end_time.is.null,start_time.gte.${nowISO})`)
    .order("start_time", { ascending: true })
    .limit(500)

  if (error) throw new Error(error.message)

  // Drop single-day events that already started earlier today; keep ongoing multi-day ones.
  const now = Date.now()
  return ((data as EventRow[]) || []).filter((r) => {
    const start = new Date(r.start_time).getTime()
    if (start >= now) return true
    const endDay = r.end_time ? nyDateOf(r.end_time) : null
    const isMultiDay = !!endDay && endDay !== nyDateOf(r.start_time)
    return isMultiDay && new Date(r.end_time as string).getTime() >= now
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const profile = body?.profile ?? {}

    const rows = await fetchAllWorldCup()

    // Geocode home/office once for best-effort travel estimates (free, cached). These are
    // informational only here — unlike the planner, we do NOT filter events by travel time.
    const [homeCoord, officeCoord] = await Promise.all([
      geocodeAddress(profile.homeAddress || ""),
      geocodeAddress(profile.officeAddress || ""),
    ])

    const todayIso = nyDateOf(new Date().toISOString())

    const activities: Activity[] = rows.map((row, i) => {
      const startDate = nyDateOf(row.start_time)
      const endDate = row.end_time ? nyDateOf(row.end_time) : null
      const multiDay = !!endDate && endDate !== startDate
      // Anchor already-started (ongoing) events to today so they sort near the top rather
      // than under a past date; single/future events keep their real start day.
      const displayDate = startDate < todayIso ? todayIso : startDate
      const isOpeningDay = displayDate === startDate
      const startTime = isOpeningDay ? nyClockOf(row.start_time) : ""
      const endTime = !multiDay && row.end_time ? nyClockOf(row.end_time) : ""

      const eventCoord: Coord | null =
        typeof row.latitude === "number" && typeof row.longitude === "number"
          ? { lat: row.latitude, lng: row.longitude }
          : null
      const detHome = eventCoord && homeCoord ? estimateTravelMinutes(homeCoord, eventCoord) : null
      const detOffice = eventCoord && officeCoord ? estimateTravelMinutes(officeCoord, eventCoord) : null

      return {
        id: `wc-${i}`,
        title: row.title,
        category: row.category || "World Cup Viewing",
        date: displayDate,
        day: nyWeekdayOf(row.start_time),
        startTime,
        endTime,
        endDate: endDate ?? "",
        venue: row.venue_name || "",
        neighborhood: row.neighborhood || "",
        address: row.address || "",
        priceLabel: row.price || "",
        indoor: guessIndoor(row.title, row.venue_name, row.description),
        url: row.event_url || "",
        imageUrl: row.image_url || "",
        why: "",
        travelNote: "",
        travelFromHome: detHome !== null ? `~${detHome} min` : "",
        travelFromOffice: detOffice !== null ? `~${detOffice} min` : "",
        approximateLocation: row.approximate_location ?? false,
      }
    })

    // De-duplicated source list from the events shown.
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

    const plan: WeeklyPlan = {
      summary:
        activities.length > 0
          ? `Every World Cup & soccer viewing event in the catalog (${activities.length} total) — the complete list, uncurated and unfiltered.`
          : "No upcoming World Cup viewing events are in the catalog right now. Check back after the next daily update.",
      activities,
      sources,
    }

    return Response.json(plan)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[v0] world cup browse error:", message)
    return Response.json({ error: "Could not load World Cup events. Please try again." }, { status: 500 })
  }
}
