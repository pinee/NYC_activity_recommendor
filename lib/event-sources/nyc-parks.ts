import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, isoDatePart, nyToUtcISO, parseClockTo24h, nyMidnightToday } from "./util"

// NYC Parks official events RSS feed. Free, no API key, and the same data behind
// nycgovparks.org. We use the RSS feed rather than the NYC Open Data Socrata dataset
// ("Upcoming 14 Days", resource w3wp-dpdi) because that dataset is refreshed
// infrequently and its horizon goes stale (it was dead-ending ~2 weeks in the past,
// so dates like July 4 were missing). The RSS feed is regenerated continuously and
// reliably covers the true upcoming ~14 days (1,000+ items across all five boroughs).
const RSS_ENDPOINT = "https://www.nycgovparks.org/xml/events_300_rss.xml"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Parsed shape of a single <item> in the RSS feed (only the fields we use).
type ParksRow = {
  title?: string
  description?: string
  guid?: string
  link?: string
  parknames?: string
  location?: string
  startdate?: string
  enddate?: string
  starttime?: string
  endtime?: string
  categories?: string
  coordinates?: string
  parkids?: string
  image?: string
}

// Pull the inner text of <tag> (or <ns:tag>), unwrapping CDATA and decoding the few
// entities the feed uses. Returns undefined when the tag is absent or empty.
function tagText(itemXml: string, tag: string): string | undefined {
  const m = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))
  if (!m) return undefined
  let v = m[1].trim()
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  if (cdata) v = cdata[1].trim()
  v = v
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  return v || undefined
}

// Parse one RSS <item> block into the field shape the mapping loop expects.
function parseItem(itemXml: string): ParksRow {
  // Event detail links come back as http://; normalize to https for clean, secure URLs.
  const link = tagText(itemXml, "link")?.replace(/^http:\/\//i, "https://")
  return {
    title: tagText(itemXml, "title"),
    description: tagText(itemXml, "description"),
    guid: tagText(itemXml, "guid"),
    link,
    parkids: tagText(itemXml, "event:parkids"),
    parknames: tagText(itemXml, "event:parknames"),
    startdate: tagText(itemXml, "event:startdate"),
    enddate: tagText(itemXml, "event:enddate"),
    starttime: tagText(itemXml, "event:starttime"),
    endtime: tagText(itemXml, "event:endtime"),
    location: tagText(itemXml, "event:location"),
    categories: tagText(itemXml, "event:categories"),
    coordinates: tagText(itemXml, "event:coordinates"),
    // Event photos are served over http; upgrade to https so they load on our secure pages.
    image: tagText(itemXml, "event:image")?.replace(/^http:\/\//i, "https://"),
  }
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
    const res = await fetch(RSS_ENDPOINT, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": BROWSER_UA },
    })
    if (!res.ok) {
      throw new Error(`NYC Parks feed returned HTTP ${res.status}`)
    }
    const xml = await res.text()

    // The feed already covers the upcoming ~14 days, but we still apply our own horizon
    // window below so this source honors the configured horizonDays exactly.
    const rows = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => parseItem(m[1]))

    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const events: NormalizedEvent[] = []
    for (const r of rows) {
      const title = r.title?.trim()
      const eventUrl = r.link?.trim()
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
        image_url: r.image && /^https:\/\//i.test(r.image) ? r.image : null,
        // Exact when the feed gave real per-event coordinates. Rows missing coordinates
        // are flagged approximate (they may be geocoded during ingest, also approximate).
        approximate_location: lat === null || lng === null,
      })
    }

    return events
  },
}
