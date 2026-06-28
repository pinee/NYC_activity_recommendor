import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, isoDatePart, nyToUtcISO, parseClockTo24h, nyMidnightToday } from "./util"

// NYC Open Data — "NYC Parks Public Events – Upcoming 14 Days" (Socrata SODA API).
// Official, free, and requires no API key. Returns real event pages on nycgovparks.org.
const SODA_ENDPOINT = "https://data.cityofnewyork.us/resource/w3wp-dpdi.json"

// Raw shape of a row from the Socrata feed (only the fields we use).
type ParksRow = {
  title?: string
  description?: string
  guid?: string
  link?: { url?: string }
  parknames?: string
  location?: string
  startdate?: string
  enddate?: string
  starttime?: string
  endtime?: string
  categories?: string
  coordinates?: string
  parkids?: string
}

// Park id prefixes map to boroughs (e.g. "R129" -> Staten Island, "M010" -> Manhattan).
const BOROUGH_BY_PREFIX: Record<string, string> = {
  M: "Manhattan",
  B: "Brooklyn",
  Q: "Queens",
  X: "Bronx",
  R: "Staten Island",
}

function boroughFromParkIds(parkids?: string): string | null {
  if (!parkids) return null
  const first = parkids.trim()[0]?.toUpperCase()
  return (first && BOROUGH_BY_PREFIX[first]) || null
}

function parseCoordinates(raw?: string): { lat: number | null; lng: number | null } {
  if (!raw) return { lat: null, lng: null }
  const parts = raw.split(",").map((p) => Number(p.trim()))
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return { lat: parts[0], lng: parts[1] }
  }
  return { lat: null, lng: null }
}

// Split "Best for Kids | Sports | Pickleball" into clean tags, and use the most
// specific one (the last) as the headline category.
function parseCategories(raw?: string): { category: string | null; tags: string[] | null } {
  if (!raw) return { category: null, tags: null }
  const tags = raw
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length === 0) return { category: null, tags: null }
  return { category: tags[tags.length - 1], tags }
}

export const nycParksSource: EventSource = {
  name: "NYC Parks",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    // The dataset holds a large backlog ordered by date, so we MUST filter
    // server-side. We keep anything still relevant today: events that START today
    // or later, OR multi-day events that END today or later (i.e. still ongoing
    // even though they began earlier). $where uses Socrata floating timestamps.
    // "sv-SE" formats as "YYYY-MM-DD HH:mm:ss", so the date part is the NY calendar date.
    const todayNY = isoDatePart(new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }))
    const where = encodeURIComponent(
      `(startdate >= '${todayNY}T00:00:00') OR (enddate >= '${todayNY}T00:00:00')`,
    )
    const url = `${SODA_ENDPOINT}?$limit=1000&$order=startdate ASC&$where=${where}`
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) {
      throw new Error(`NYC Parks feed returned HTTP ${res.status}`)
    }
    const rows = (await res.json()) as ParksRow[]

    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const events: NormalizedEvent[] = []
    for (const r of rows) {
      const title = r.title?.trim()
      const eventUrl = r.link?.url?.trim()
      const startDate = isoDatePart(r.startdate)
      if (!title || !eventUrl || !startDate) continue

      const startTime = nyToUtcISO(startDate, parseClockTo24h(r.starttime))
      if (!startTime) continue

      const endDate = isoDatePart(r.enddate)
      const endTime = endDate ? nyToUtcISO(endDate, parseClockTo24h(r.endtime)) : null

      // Keep events whose [start, end] span overlaps the rolling [today, today+horizon]
      // window. A single-day event has no end, so its span is just its start moment.
      const startMs = new Date(startTime).getTime()
      const endMs = endTime ? new Date(endTime).getTime() : startMs
      if (endMs < startWindow) continue // already finished
      if (startMs > endWindow) continue // starts after the window

      const { lat, lng } = parseCoordinates(r.coordinates)
      const { category, tags } = parseCategories(r.categories)

      events.push({
        id: deterministicId(["NYC Parks", r.guid || `${title}|${startTime}`]),
        title,
        description: r.description?.trim() || null,
        source: "NYC Parks",
        source_event_id: r.guid || null,
        event_url: eventUrl,
        venue_name: r.parknames?.trim() || null,
        address: r.location?.trim() || r.parknames?.trim() || null,
        latitude: lat,
        longitude: lng,
        borough: boroughFromParkIds(r.parkids),
        neighborhood: null,
        category,
        tags,
        organizer: "NYC Parks",
        start_time: startTime,
        end_time: endTime,
        price: "Free", // NYC Parks public programming is free to attend.
        currency: "USD",
        image_url: null,
      })
    }

    return events
  },
}
