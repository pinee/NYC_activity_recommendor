import { WORLD_CUP_CATEGORY } from "@/lib/event-sources/util"
import { createServiceClient } from "@/lib/supabase/server"
import { geocodeAddress, estimateTravelMinutes, type Coord } from "@/lib/geo"
import type { PlanSource, WorldCupSpot, WorldCupSpotsResult } from "@/lib/types"

export const maxDuration = 30

// ---- NYC-local date/time helpers (mirrors the plan route) ----

function nyDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
}

// Format an ISO calendar date ("2026-07-01") as "Jul 1" without any UTC shift.
function shortDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return isoDate
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// Build a human date-span label for a spot from its first/last session dates and whether
// the underlying event is a single continuous multi-day run.
function spanLabel(firstDate: string, lastDate: string, todayIso: string, isMultiDay: boolean): string {
  if (firstDate === lastDate) return shortDate(firstDate)
  // A single ongoing multi-day event that started before today reads as "Through <end>".
  if (isMultiDay && firstDate <= todayIso) return `Through ${shortDate(lastDate)}`
  return `${shortDate(firstDate)} – ${shortDate(lastDate)}`
}

// Best-effort indoor/outdoor guess for display. Fan zones, parks, and big-screen
// screenings are outdoor; bars, pubs, lounges, cinemas, and rooftops read as indoor.
function guessIndoor(title: string | null, venue: string | null, description: string | null): boolean {
  const t = `${title || ""} ${venue || ""} ${description || ""}`.toLowerCase()
  // Rooftops are open-air, and explicit outdoor venues (fan zones, parks, piers) come first.
  if (/\b(fan zone|fan village|big screen|park|plaza|outdoor|waterfront|pier|rooftop|garden)\b/.test(t)) return false
  // Indoor venue keywords, including soccer/ping-pong bars and BBQ/grill restaurants.
  if (
    /\b(bar|pub|tavern|lounge|club|cinema|theater|theatre|indoor|hall|restaurant|social|grill|bbq|socceroof|spin|kitchen|eatery)\b/.test(
      t,
    )
  )
    return true
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

    // Aggregate individual sessions into one entry per SPOT. The grouping key is the venue
    // name when present, otherwise the event title (so distinct null-venue events like the
    // Rockefeller Fan Village and "The Fox" stay separate, while repeated sessions at the
    // same venue — e.g. six days at Market 57 or ten Battery screenings — collapse into one).
    type Agg = {
      row: EventRow
      firstDate: string
      lastDate: string
      isMultiDay: boolean
      sessions: number
      coord: Coord | null
    }
    const groups = new Map<string, Agg>()

    for (const row of rows) {
      const key = (row.venue_name?.trim() || row.title.trim()).toLowerCase()
      const startDate = nyDateOf(row.start_time)
      const endDate = row.end_time ? nyDateOf(row.end_time) : startDate
      const rowMultiDay = endDate !== startDate
      const coord: Coord | null =
        typeof row.latitude === "number" && typeof row.longitude === "number"
          ? { lat: row.latitude, lng: row.longitude }
          : null

      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          row,
          firstDate: startDate,
          lastDate: endDate,
          isMultiDay: rowMultiDay,
          sessions: 1,
          coord,
        })
      } else {
        existing.sessions += 1
        if (startDate < existing.firstDate) existing.firstDate = startDate
        if (endDate > existing.lastDate) existing.lastDate = endDate
        existing.isMultiDay = existing.isMultiDay || rowMultiDay
        if (!existing.coord && coord) existing.coord = coord
        // Prefer a representative row that has an image, then a URL.
        if ((!existing.row.image_url && row.image_url) || (!existing.row.event_url && row.event_url)) {
          existing.row = row
        }
      }
    }

    // Order spots by when their viewing first becomes available.
    const ordered = Array.from(groups.values()).sort((a, b) => {
      const d = a.firstDate.localeCompare(b.firstDate)
      return d !== 0 ? d : a.row.title.localeCompare(b.row.title)
    })

    const spots: WorldCupSpot[] = ordered.map((g, i) => {
      const detHome = g.coord && homeCoord ? estimateTravelMinutes(homeCoord, g.coord) : null
      const detOffice = g.coord && officeCoord ? estimateTravelMinutes(officeCoord, g.coord) : null
      return {
        id: `wc-spot-${i}`,
        name: g.row.venue_name?.trim() || g.row.title,
        venue: g.row.venue_name || "",
        neighborhood: g.row.neighborhood || "",
        address: g.row.address || "",
        borough: "",
        firstDate: g.firstDate,
        lastDate: g.lastDate,
        dateSpanLabel: spanLabel(g.firstDate, g.lastDate, todayIso, g.isMultiDay),
        sessions: g.sessions,
        priceLabel: g.row.price || "",
        indoor: guessIndoor(g.row.title, g.row.venue_name, g.row.description),
        url: g.row.event_url || "",
        imageUrl: g.row.image_url || "",
        travelFromHome: detHome !== null ? `~${detHome} min` : "",
        travelFromOffice: detOffice !== null ? `~${detOffice} min` : "",
        approximateLocation: g.row.approximate_location ?? false,
      }
    })

    // De-duplicated source list from the spots shown.
    const sources: PlanSource[] = Array.from(
      new Map(
        rows
          .filter((r) => r.event_url)
          .map((r) => {
            let host = ""
            try {
              host = new URL(r.event_url as string).hostname.replace(/^www\./, "")
            } catch {
              host = r.event_url as string
            }
            return [host, { title: r.source || host, url: r.event_url as string, host }]
          }),
      ).values(),
    )

    const result: WorldCupSpotsResult = {
      summary:
        spots.length > 0
          ? `${spots.length} spots across NYC with World Cup & soccer viewing — every place with viewing, shown with its date span.`
          : "No upcoming World Cup viewing spots are in the catalog right now. Check back after the next daily update.",
      spots,
      sources,
    }

    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[v0] world cup browse error:", message)
    return Response.json({ error: "Could not load World Cup events. Please try again." }, { status: 500 })
  }
}
