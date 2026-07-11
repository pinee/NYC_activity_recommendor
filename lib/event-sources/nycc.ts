import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday, nyToUtcISO } from "./util"

// New York Cycle Club (nycc.org/events-calendar) — the city's largest cycling club: weekend
// getaways, all-class rides, mechanics clinics, first-aid classes, newcomer rides, and social
// events. The site is a Webflow build that renders its events as a CMS collection. Each event
// is a `w-dyn-item` card containing a date (or date range like "July 10, 2026 - July 13, 2026"),
// an <h3> title, a "Location:" label + value, a description, an image, and a link to the event's
// own /events/<slug> page. We parse those cards directly.
//
// NYCC events frequently take place outside NYC (Vermont, the Berkshires, the Finger Lakes), and
// the cards carry only a free-text location with no coordinates, so we surface the location text
// and mark every event's location approximate.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const BASE = "https://nycc.org"
const URL = `${BASE}/events-calendar`

const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
}

// "July 10, 2026" -> "2026-07-10" (NY wall-clock date). Returns null if unparseable.
function fullDateToISODate(raw: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(raw)
  if (!m) return null
  const mo = MONTH_INDEX[m[1].toLowerCase()]
  if (mo === undefined) return null
  const day = Number(m[2])
  const year = Number(m[3])
  if (!day || day < 1 || day > 31) return null
  return `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// Split the events page into individual Webflow collection-item chunks.
function splitItems(html: string): string[] {
  const parts = html.split(/class="[^"]*w-dyn-item[^"]*"/g)
  // The first chunk is everything before the first item; drop it.
  return parts.slice(1)
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export const nyccSource: EventSource = {
  name: "New York Cycle Club",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const html = await fetchText(URL)
    if (!html) return []

    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    for (const chunk of splitItems(html)) {
      // Cut the chunk at the next item boundary already handled by split; use as-is.
      // Title: first <h3>.
      const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(chunk)
      const title = titleMatch ? stripTags(titleMatch[1]) : ""
      if (!title) continue

      // Dates: all "Month D, YYYY" occurrences; first is start, second (if any) is end.
      const dateStrings = [...chunk.matchAll(/[A-Za-z]+\s+\d{1,2},\s*\d{4}/g)].map((m) => m[0])
      const startDate = dateStrings[0] ? fullDateToISODate(dateStrings[0]) : null
      if (!startDate) continue
      const endDate = dateStrings[1] ? fullDateToISODate(dateStrings[1]) : null

      const startISO = nyToUtcISO(startDate, "00:00")
      if (!startISO) continue
      const endISO = endDate ? nyToUtcISO(endDate, "00:00") : null

      // Keep events whose span overlaps the rolling window (end date is inclusive; treat the
      // whole final day as in-window by adding a day).
      const startMs = new Date(startISO).getTime()
      const spanEndMs = endISO ? new Date(endISO).getTime() + 86400000 : startMs + 86400000
      if (spanEndMs < startWindow || startMs > endWindow) continue

      // Location: text after a "Location:" label.
      const locMatch = /Location:\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i.exec(chunk)
      const location = locMatch ? stripTags(locMatch[1]) : null

      // Link to the event's own page.
      const linkMatch = /href="(\/events\/[^"#?]+)"/i.exec(chunk)
      const path = linkMatch ? linkMatch[1] : null
      const eventUrl = path ? `${BASE}${path}` : URL

      // First image (prefer a plain src that isn't a data URI).
      const imgMatch = /<img[^>]*\ssrc="(https?:\/\/[^"]+)"/i.exec(chunk)
      const imageUrl = imgMatch ? imgMatch[1] : null

      // Short description from the rich-text block, if present.
      const descMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)
      const description = descMatch ? stripTags(descMatch[1]) || null : null

      // De-dupe on the event slug (or title+date when there's no link).
      const dedupeKey = path || `${title}|${startDate}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      out.push({
        id: deterministicId(["New York Cycle Club", dedupeKey]),
        title,
        description,
        source: "New York Cycle Club",
        source_event_id: path ? path.replace("/events/", "") : null,
        event_url: eventUrl,
        venue_name: location,
        address: location,
        latitude: null,
        longitude: null,
        borough: null,
        neighborhood: null,
        // Everything NYCC runs is a cycling-club event (rides, weekends away, mechanics &
        // first-aid clinics, social rides), so we classify the whole source as "Cycling"
        // rather than inferring from title/description text (which misfires on incidental
        // words like "market" or "run" in an event's blurb).
        category: "Cycling",
        tags: ["Cycling", "New York Cycle Club"],
        organizer: "New York Cycle Club",
        start_time: startISO,
        end_time: endISO,
        price: null,
        currency: "USD",
        image_url: imageUrl,
        // Cards carry only free-text locations (often outside NYC) with no coordinates.
        approximate_location: true,
      })
    }

    return out
  },
}
