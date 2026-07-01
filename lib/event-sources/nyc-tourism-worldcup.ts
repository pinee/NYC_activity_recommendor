import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, isoDatePart, nyToUtcISO, inferCategoryFromText } from "./util"

// NYC Tourism's official FIFA World Cup 2026 hub (nyctourism.com/worldcup26). The listing
// page is a Next.js/Contentful page that server-renders a set of curated "/events/<slug>"
// links, and each event's detail page carries a clean schema.org JSON-LD `Event` block with
// name/description/startDate/endDate/location. Both the listing and detail pages return 200
// to a plain server fetch (no bot protection), so we fetch directly and fall back to the
// r.jina.ai reader proxy only if a direct request ever fails.
//
// These are city-wide World Cup happenings (soccer tournaments, watch parties, museum
// programming, summer festivals). They're published as all-day DATE RANGES (startDate/endDate
// at midnight, no clock time), several of them multi-day and already running — so we default
// all-day events to a noon start, set an end_time for true multi-day spans (which keeps
// ongoing events in the plan's rolling window until they finish), and treat same-day ranges
// as single-day.
const SOURCE_NAME = "NYC Tourism (World Cup 2026)"
const ORIGIN = "https://www.nyctourism.com"
const LISTING_URL = `${ORIGIN}/worldcup26/world-cup-offers-and-events/`
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// Politeness/run-time bounds for detail-page fetches (the hub lists only a handful today).
const MAX_DETAIL_FETCHES = 40
const DETAIL_CONCURRENCY = 5
// Fallback point for city-wide events with no specific venue (central Midtown Manhattan).
const NYC_CENTER = { lat: 40.7484, lng: -73.9857 }

// Fetch a URL directly (with a browser UA), falling back to the reader proxy on failure.
async function fetchHtml(url: string): Promise<string> {
  try {
    const direct = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": BROWSER_UA },
      redirect: "follow",
    })
    if (direct.ok) return await direct.text()
  } catch {
    // fall through to proxy
  }
  const proxied = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "x-respond-with": "html", "User-Agent": BROWSER_UA },
  })
  if (!proxied.ok) throw new Error(`fetch failed: ${url} (proxy HTTP ${proxied.status})`)
  return proxied.text()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Pull the first schema.org Event object out of a detail page's JSON-LD blocks. Handles a
// bare object, an array, or an @graph wrapper.
function extractEventJsonLd(html: string): Record<string, any> | null {
  for (const b of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(b[1])
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]
      for (const o of arr) {
        if (o && o["@type"] === "Event") return o
      }
    } catch {
      // skip malformed block
    }
  }
  return null
}

// Extract "HH:MM" from an ISO timestamp, or "" if absent.
function timeFromISO(iso: string | null | undefined): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso || "")
  return m ? `${m[1]}:${m[2]}` : ""
}

// Compose a geocodable address from schema.org PostalAddress parts. Returns "" if there's no
// street-level detail (i.e. a city-wide event).
function buildAddress(loc: Record<string, any> | undefined): string {
  const addr = loc?.address
  if (!addr || typeof addr !== "object") return ""
  const street = (addr.streetAddress || "").trim()
  if (!street) return ""
  // Some feeds already fold locality/region/zip into streetAddress; only append the parts
  // that aren't already present to avoid duplication.
  const parts = [street]
  for (const extra of [addr.addressLocality, addr.addressRegion, addr.postalCode]) {
    const v = (extra || "").toString().trim()
    if (v && !street.toLowerCase().includes(v.toLowerCase())) parts.push(v)
  }
  return parts.join(", ")
}

// Detect the borough from an address string, or null when it's not borough-specific.
function detectBorough(text: string): string | null {
  const hay = text.toLowerCase()
  if (/\bbronx\b/.test(hay)) return "Bronx"
  if (/\bbrooklyn\b/.test(hay)) return "Brooklyn"
  if (/\bqueens\b/.test(hay)) return "Queens"
  if (/\bstaten island\b/.test(hay)) return "Staten Island"
  if (/\bmanhattan\b|\bnew york\b/.test(hay)) return "Manhattan"
  return null
}

// Category resolver tuned for this World Cup hub. Ordered so the most specific signal wins:
// an explicit festival/celebration, then museum/gallery programming, then the soccer/World
// Cup core theme, then general keyword inference — defaulting to "Sports & games" since every
// event here orbits the tournament.
function resolveCategory(title: string, desc: string): string {
  const hay = `${title} ${desc}`.toLowerCase()
  if (/\bfestiv|celebrat|\bbirthday\b|tall ships?|\bparade\b|fireworks?/.test(hay)) return "Festivals & fireworks"
  if (/\bmuseum\b|\bwhitney\b|\bgallery\b|\bexhibit/.test(hay)) return "Museums"
  if (/\bsoccer\b|world cup|watch party|\btournament\b|\bmatches?\b/.test(hay)) return "Sports & games"
  return inferCategoryFromText(title, desc) || "Sports & games"
}

// Resolve an array of items with bounded concurrency.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      try {
        results.push(await fn(items[idx]))
      } catch {
        // skip individual failures
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function buildEvent(url: string): Promise<NormalizedEvent | null> {
  const html = await fetchHtml(url)
  const ld = extractEventJsonLd(html)
  if (!ld) return null

  const title = decodeEntities(ld.name || "")
  if (!title) return null
  const description = ld.description ? decodeEntities(ld.description) : null

  const startDatePart = isoDatePart(ld.startDate)
  if (!startDatePart) return null
  const endDatePart = isoDatePart(ld.endDate) || startDatePart

  // All-day (midnight) events default to a noon start so they don't render as "12:00 AM".
  const startClock = timeFromISO(ld.startDate)
  const startTime = !startClock || startClock === "00:00" ? "12:00" : startClock
  const startUtc = nyToUtcISO(startDatePart, startTime)
  if (!startUtc) return null

  // Multi-day span → keep an end_time (last day, end of day) so the plan window keeps the
  // event visible while it's ongoing. Same-day range → single-day event (no end_time).
  const isMultiDay = endDatePart > startDatePart
  const endUtc = isMultiDay ? nyToUtcISO(endDatePart, "23:59") : null

  const address = buildAddress(ld.location)
  const locName = (ld.location?.name || "").trim()
  const hasStreet = address.length > 0
  const borough = detectBorough(`${address} ${locName}`)

  return {
    id: deterministicId([SOURCE_NAME, url]),
    title,
    description,
    source: SOURCE_NAME,
    source_event_id: url.replace(`${ORIGIN}/events/`, "").replace(/\/$/, "") || url,
    event_url: url,
    // Prefer a named venue; otherwise the street address; otherwise mark it city-wide.
    venue_name: locName && locName.toLowerCase() !== "new york city" ? locName : hasStreet ? null : "New York City",
    address: hasStreet ? address : null,
    // With a real street address we leave coordinates null so the ingest geocoder resolves
    // them precisely; city-wide events fall back to a central Manhattan point (approximate).
    latitude: hasStreet ? null : NYC_CENTER.lat,
    longitude: hasStreet ? null : NYC_CENTER.lng,
    borough,
    neighborhood: null,
    category: resolveCategory(title, description || ""),
    tags: ["world cup 2026", "nyc tourism"],
    organizer: "NYC Tourism",
    start_time: startUtc,
    end_time: endUtc,
    price: null,
    currency: null,
    image_url: typeof ld.image === "string" && ld.image ? ld.image : null,
    // City-wide fallback coords are approximate; street-addressed events are refined (and
    // flagged) by the geocoder.
    approximate_location: !hasStreet,
  }
}

export const nycTourismWorldCupSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const listing = await fetchHtml(LISTING_URL)

    // Collect unique /events/<slug> links from the listing.
    const slugs = new Set<string>()
    for (const m of listing.matchAll(/\/events\/([a-z0-9-]+)/g)) slugs.add(m[1])
    const urls = [...slugs].slice(0, MAX_DETAIL_FETCHES).map((s) => `${ORIGIN}/events/${s}`)
    if (urls.length === 0) return []

    const built = (await mapWithConcurrency(urls, DETAIL_CONCURRENCY, buildEvent)).filter(
      (e): e is NormalizedEvent => e !== null,
    )

    // Keep events whose date span overlaps the ingest horizon: they start on/before the
    // horizon end AND end on/after today (so ongoing multi-day events are retained). We
    // compare at noon to avoid timezone/DST edge effects at day boundaries.
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startOfToday = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const horizonEnd = new Date(startOfToday.getTime() + horizonDays * 86400000)

    return built.filter((e) => {
      const start = new Date(e.start_time)
      const end = e.end_time ? new Date(e.end_time) : start
      return start <= horizonEnd && end >= startOfToday
    })
  },
}
