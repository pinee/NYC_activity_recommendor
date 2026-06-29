import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyToUtcISO, parseClockTo24h } from "./util"

// Rooftop Films' summer calendar is server-rendered HTML. Each screening is a ".card" with
// a title, program category, venue/neighborhood, a day/month/date/time block, a status
// "message" (price hint), and a link to the event page. We parse those cards.
// Screenings happen at venues all over the city (rooftops, cemeteries, parks), so unlike a
// single-venue source the location varies per event and we let the ingest geocoder resolve
// it from the venue text (approximate).
const SOURCE_NAME = "Rooftop Films"
const PAGE_URL = "https://rooftopfilms.com/calendar/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function clean(s: string | null | undefined): string {
  if (!s) return ""
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Pull the borough out of the trailing location text (e.g. "Industry City, Sunset Park,
// Brooklyn" -> "Brooklyn"). Returns null when none of the five boroughs appear.
function parseBorough(location: string): string | null {
  const m = location.match(/\b(Brooklyn|Manhattan|Queens|Bronx|Staten Island)\b/i)
  if (!m) return null
  const b = m[1].toLowerCase()
  return b === "staten island"
    ? "Staten Island"
    : b.charAt(0).toUpperCase() + b.slice(1)
}

// The neighborhood is the second-to-last comma segment when a borough is present
// ("Green-Wood Cemetery, Greenwood, Brooklyn" -> "Greenwood").
function parseNeighborhood(location: string, borough: string | null): string | null {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean)
  if (borough && parts.length >= 2) return parts[parts.length - 2] || null
  return parts.length >= 2 ? parts[parts.length - 1] : null
}

function parsePrice(message: string): string | null {
  const m = message.toLowerCase()
  if (m.includes("free")) return "Free"
  // "TICKETS ON SALE" / "SOLD OUT" / "RSVP" carry no dollar amount on the listing page.
  return null
}

function parseCards(html: string, todayNY: Date): NormalizedEvent[] {
  // Each event begins at a card-image-wrap; the body (title/category/location) follows.
  const chunks = html.split(/class="card-image-wrap"/).slice(1)
  const out: NormalizedEvent[] = []
  const now = Date.now()

  for (const c of chunks) {
    const title = clean((c.match(/card-title">([\s\S]*?)<\/h4>/) || [])[1])
    const url = (c.match(/href="(https:\/\/rooftopfilms\.com\/event\/[^"]+)"/) || [])[1] || null
    if (!title || !url) continue

    const program = clean((c.match(/card-category">([\s\S]*?)<\/p>/) || [])[1]) || null
    const location = clean((c.match(/card-location">([\s\S]*?)<\/p>/) || [])[1]) || null
    const month = clean((c.match(/event-month">([\s\S]*?)<\/span>/) || [])[1])
    const day = clean((c.match(/event-date">([\s\S]*?)<\/span>/) || [])[1])
    const time = clean((c.match(/event-time">([\s\S]*?)<\/span>/) || [])[1])
    const message = clean((c.match(/card-message[^>]*>([\s\S]*?)<\/span>/) || [])[1])

    const date = monthDayToNyDate(month, Number(day), todayNY)
    if (!date) continue
    const startUtc = nyToUtcISO(date, parseClockTo24h(time))
    if (!startUtc) continue
    if (new Date(startUtc).getTime() < now) continue

    const borough = location ? parseBorough(location) : null
    const neighborhood = location ? parseNeighborhood(location, borough) : null
    // The venue name is the first comma segment ("The Old American Can Factory").
    const venue = location ? location.split(",")[0].trim() : null

    out.push({
      id: deterministicId([SOURCE_NAME, url]),
      title,
      description: program,
      source: SOURCE_NAME,
      source_event_id: url,
      event_url: url,
      venue_name: venue,
      // Feed the geocoder the full venue string; add the city when no borough is present.
      address: location ? (borough ? `${location}, NY` : `${location}, New York, NY`) : null,
      latitude: null,
      longitude: null,
      borough,
      neighborhood,
      category: "Film & cinema",
      tags: ["rooftop films", "outdoor film", ...(program ? [program.toLowerCase()] : [])],
      organizer: "Rooftop Films",
      start_time: startUtc,
      end_time: null,
      price: parsePrice(message),
      currency: null,
      image_url: null,
      // No coordinates from the page; the ingest geocoder resolves the venue text, so the
      // point is an approximation until/unless it matches a full street address.
      approximate_location: true,
    })
  }
  return out
}

export const rooftopFilmsSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents() {
    const res = await fetch(PAGE_URL, { headers: { Accept: "text/html", "User-Agent": BROWSER_UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    return parseCards(html, todayNY)
  },
}
