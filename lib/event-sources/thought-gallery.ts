import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"

// thoughtgallery.org — "NYC's calendar for the intellectually curious": talks, lectures,
// readings, screenings. NOT an API; it's a custom-rendered HTML list, so we parse it.
// The "/all-categories/" page groups events under date headers, each item shaped like:
//   <h2 class="date_group_header">Monday, June 29, 2026</h2>
//   <div class="all_categories_item_container">
//     <div class="all_categories_time_container">6:00 PM</div>
//     <div class="all_categories_event_container">
//       <h3><a href="events/...">Title</a></h3>
//       <span class="location">Venue (Neighborhood)</span><br>
//       <span class="category"><a ...>Books</a></span>, <span class="category">...</span>
//     </div>
//   </div>
// Parsing is best-effort: malformed items are skipped rather than guessed.
const SOURCE_NAME = "Thought Gallery"
const PAGE_URL = "https://thoughtgallery.org/all-categories/"
const BASE_URL = "https://thoughtgallery.org/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;|&#34;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8230;/g, "...")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

// "Monday, June 29, 2026" -> "2026-06-29" (or null).
function parseDateHeader(raw: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(stripTags(raw))
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const day = Number(m[2])
  const year = Number(m[3])
  if (day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// Map Thought Gallery's own category slugs (most specific first) to one of our interests.
// Logistics tags (free / in-person / virtual) are ignored here. Anything that doesn't map
// to a specific interest falls back to "Talks & lectures" (the site's core format).
const SLUG_TO_INTEREST: Record<string, string> = {
  literary: "Books & readings",
  art: "Art & galleries",
  design: "Art & galleries",
  music: "Film & cinema", // TG's "Performing Arts/Film" bucket
  "food-drink": "Food & dining",
  science: "Tech & startups",
  history: "Museums",
}

function inferCategory(slugs: string[]): string {
  for (const slug of slugs) {
    if (SLUG_TO_INTEREST[slug]) return SLUG_TO_INTEREST[slug]
  }
  return "Talks & lectures"
}

// Pull "(Neighborhood)" out of a location string, leaving the venue name.
function splitVenue(location: string): { venue: string | null; neighborhood: string | null } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(location)
  if (m) {
    const venue = m[1].trim()
    const inside = m[2].trim()
    // "(Location TBA)" is not a neighborhood; treat the whole thing as the venue label.
    if (/tba|tbd|online|virtual/i.test(inside)) return { venue: location || null, neighborhood: null }
    return { venue: venue || null, neighborhood: inside || null }
  }
  return { venue: location || null, neighborhood: null }
}

function parseList(html: string, horizonDays: number): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const nowMs = Date.now()
  const horizonMs = nowMs + horizonDays * 86400000

  // Walk the document in order, tracking the most recent date header. We tokenize on the
  // two markers we care about (date headers and item containers) so events attach to the
  // correct date.
  const tokenRe = /<h2 class="date_group_header">([\s\S]*?)<\/h2>|<div class="all_categories_item_container">([\s\S]*?)<\/div>\s*<\/div>/g
  let currentDate: string | null = null
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1] !== undefined) {
      // Date header token.
      currentDate = parseDateHeader(match[1])
      continue
    }
    const item = match[2]
    if (!currentDate) continue

    // Time, e.g. "6:00 PM".
    const time = (item.match(/all_categories_time_container">([^<]*)</) || [])[1]?.trim() || ""

    // Title + relative URL.
    const titleMatch = item.match(/<h3>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/)
    if (!titleMatch) continue
    let url: string | null = titleMatch[1].trim()
    url = url ? new URL(url, BASE_URL).toString() : null
    const title = stripTags(titleMatch[2]).replace(/\s+SOLD OUT\s*$/i, "").trim()
    if (!title) continue

    // Location (optional).
    const locationRaw = (item.match(/<span class="location">([\s\S]*?)<\/span>/) || [])[1]
    const location = locationRaw ? stripTags(locationRaw) : null

    // Category slugs + labels.
    const slugs: string[] = []
    const labels: string[] = []
    for (const c of item.matchAll(/events\/categories\/([a-z0-9-]+)\/">([^<]+)</g)) {
      slugs.push(c[1])
      labels.push(stripTags(c[2]))
    }

    // Exclude online-only events: keep anything explicitly in-person (incl. hybrids), and
    // drop events that are virtual-tagged or clearly online in the title without an
    // in-person component.
    const hasInPerson = slugs.includes("in-person")
    const looksOnline = slugs.includes("virtual") || /\b(online|virtual|webinar|livestream|zoom)\b/i.test(title)
    if (!hasInPerson && looksOnline) continue

    const startUtc = nyToUtcISO(currentDate, time ? to24h(time) : "00:00")
    if (!startUtc) continue
    const startMs = new Date(startUtc).getTime()
    // Skip past events and anything beyond the ingest horizon.
    if (startMs < nowMs - 12 * 3600000 || startMs > horizonMs) continue

    const { venue, neighborhood } = location ? splitVenue(location) : { venue: null, neighborhood: null }
    const isFree = slugs.includes("free")
    const category = inferCategory(slugs)

    out.push({
      id: deterministicId([SOURCE_NAME, url || title]),
      title,
      description: null,
      source: SOURCE_NAME,
      source_event_id: url || title,
      event_url: url,
      venue_name: venue,
      // Feed the ingest geocoder a named venue (these resolve well at venue level).
      address: venue ? `${venue}, New York, NY` : null,
      latitude: null,
      longitude: null,
      borough: null,
      neighborhood,
      category,
      tags: [...new Set([...labels, "talk"])],
      organizer: null,
      start_time: startUtc,
      end_time: null,
      price: isFree ? "Free" : null,
      currency: null,
      image_url: null,
      // No exact coordinates in the feed; the ingest geocoder fills an approximate point.
      approximate_location: true,
    })
  }
  return out
}

// "6:00 PM" / "10:30 AM" -> "HH:MM" (24h). Returns "" when unparseable (treated as 00:00).
function to24h(raw: string): string {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(raw)
  if (!m) return ""
  let hour = Number(m[1])
  const min = Number(m[2])
  const ampm = m[3]?.toLowerCase()
  if (ampm === "pm" && hour < 12) hour += 12
  if (ampm === "am" && hour === 12) hour = 0
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

export const thoughtGallerySource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const res = await fetch(PAGE_URL, { headers: { Accept: "text/html", "User-Agent": BROWSER_UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    return parseList(html, horizonDays || 14)
  },
}
