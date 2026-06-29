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

// Rooftop Films screens at a recurring set of venues across the city. The Census geocoder
// only resolves full street addresses, not venue names ("Industry City") or neighborhoods,
// so we map the known recurring venues to coordinates here. Matched by a normalized prefix
// of the location's first comma-segment. These are venue-level points (still approximate).
const VENUE_COORDS: Array<{ match: string; lat: number; lng: number }> = [
  { match: "the old american can factory", lat: 40.6766, lng: -73.9905 },
  { match: "industry city", lat: 40.6557, lng: -74.0058 },
  { match: "green-wood cemetery", lat: 40.6518, lng: -73.9899 },
  { match: "the louis armstrong house", lat: 40.7547, lng: -73.8615 },
  { match: "brooklyn grange sunset park", lat: 40.6562, lng: -74.0095 },
  { match: "central park", lat: 40.7969, lng: -73.9587 },
  { match: "gansevoort plaza", lat: 40.739, lng: -74.008 },
  { match: "mckinley park", lat: 40.6276, lng: -74.0107 },
  { match: "new york hall of science", lat: 40.7396, lng: -73.8516 },
  { match: "new design high school", lat: 40.7166, lng: -73.9897 },
  { match: "made bush terminal", lat: 40.6549, lng: -74.0123 },
  { match: "fort greene park", lat: 40.6919, lng: -73.9755 },
  { match: "kensington plaza", lat: 40.6433, lng: -73.9729 },
  { match: "herbert von king park", lat: 40.6906, lng: -73.9442 },
]

function venueCoords(location: string | null): { lat: number; lng: number } | null {
  if (!location) return null
  const first = location.split(",")[0].trim().toLowerCase()
  for (const v of VENUE_COORDS) {
    if (first.startsWith(v.match) || first.includes(v.match)) return { lat: v.lat, lng: v.lng }
  }
  return null
}

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

function parseCards(html: string, todayNY: Date, horizonDays: number): NormalizedEvent[] {
  // Each event begins at a card-image-wrap; the body (title/category/location) follows.
  const chunks = html.split(/class="card-image-wrap"/).slice(1)
  const out: NormalizedEvent[] = []
  const now = Date.now()
  // Only keep events within the ingest horizon; the calendar lists months ahead.
  const horizonEnd = now + horizonDays * 86400000

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
    const startMs = new Date(startUtc).getTime()
    if (startMs < now || startMs > horizonEnd) continue

    const borough = location ? parseBorough(location) : null
    const neighborhood = location ? parseNeighborhood(location, borough) : null
    // The venue name is the first comma segment ("The Old American Can Factory").
    const venue = location ? location.split(",")[0].trim() : null
    // Resolve coordinates from our known-venue table (Census can't geocode venue names).
    const coords = venueCoords(location)

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
      latitude: coords?.lat ?? null,
      longitude: coords?.lng ?? null,
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
  async fetchEvents({ horizonDays }) {
    const res = await fetch(PAGE_URL, { headers: { Accept: "text/html", "User-Agent": BROWSER_UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    return parseCards(html, todayNY, horizonDays)
  },
}
