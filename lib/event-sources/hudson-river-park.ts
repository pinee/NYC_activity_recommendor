import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Hudson River Park (hudsonriverpark.org) sits behind Cloudflare bot management that
// fingerprints the TLS/HTTP client: every direct server-side fetch (undici/Node) returns
// 403 regardless of headers, even though a real browser/curl works. We therefore route all
// requests through the free r.jina.ai reader proxy, which fetches with a browser
// fingerprint. With the `x-respond-with: html` header it returns the page's original HTML.
//
// The homepage events widget only shows a narrow, CDN-cached rolling window (~3 days), so
// instead we read the WordPress event sitemaps (every event URL, with a date-stamped slug
// like `...-july-10-2026/`), filter to the ingest horizon by slug date, and then fetch each
// event's detail page for its title/time/location (carried in the og: meta tags).
const SOURCE_NAME = "Hudson River Park"
const ORIGIN = "https://hudsonriverpark.org"
const EVENT_SITEMAPS = ["events-sitemap.xml", "events-sitemap2.xml", "events-sitemap3.xml"]
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// Bound the number of detail-page fetches per ingest run (politeness + run time).
const MAX_DETAIL_FETCHES = 70
const DETAIL_CONCURRENCY = 5

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

// Fetch a URL through the reader proxy (origin is Cloudflare-blocked from the server). We
// attempt a direct fetch first in case the block is ever lifted, then fall back to proxy.
async function fetchViaProxy(url: string, expectMarker?: string): Promise<string> {
  try {
    const direct = await fetch(url, { headers: { Accept: "text/html", "User-Agent": BROWSER_UA } })
    if (direct.ok) {
      const html = await direct.text()
      if (!expectMarker || html.includes(expectMarker)) return html
    }
  } catch {
    // fall through to proxy
  }
  const proxied = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "x-respond-with": "html", "User-Agent": BROWSER_UA },
  })
  if (!proxied.ok) throw new Error(`proxy HTTP ${proxied.status}`)
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

function metaContent(html: string, prop: string): string | null {
  const m = html.match(new RegExp(`(?:property|name)="${prop}"\\s+content="([^"]*)"`, "i"))
  return m ? decodeEntities(m[1]) : null
}

// Precise coordinates for Hudson River Park's piers/segments. The park is a thin ribbon
// along the Hudson from Tribeca to 59th St, so each pier/named area is a fixed, well-known
// point — mapping it to coordinates makes travel times exact.
const PARK_CENTER = { lat: 40.7322, lng: -74.0111 }
const PIER_COORDS: Record<string, { lat: number; lng: number }> = {
  "pier 25": { lat: 40.7205, lng: -74.0145 },
  "pier 26": { lat: 40.7218, lng: -74.0152 },
  "pier 40": { lat: 40.7286, lng: -74.0113 },
  "pier 45": { lat: 40.7338, lng: -74.011 },
  "pier 46": { lat: 40.7355, lng: -74.0103 },
  "pier 51": { lat: 40.7388, lng: -74.0099 },
  "pier 57": { lat: 40.743, lng: -74.0095 },
  "pier 61": { lat: 40.7472, lng: -74.0088 },
  "pier 62": { lat: 40.748, lng: -74.0085 },
  "pier 63": { lat: 40.749, lng: -74.0083 },
  "pier 64": { lat: 40.7503, lng: -74.0086 },
  "pier 66": { lat: 40.7521, lng: -74.0086 },
  "pier 76": { lat: 40.7607, lng: -74.0028 },
  "pier 84": { lat: 40.7644, lng: -73.9998 },
  "pier 86": { lat: 40.7647, lng: -74.0005 },
  "pier 96": { lat: 40.77, lng: -73.9985 },
  "pier 97": { lat: 40.7712, lng: -73.998 },
}
// Named (non-"Pier N") locations that appear in event copy.
const NAMED_COORDS: Array<{ match: string; lat: number; lng: number }> = [
  { match: "gansevoort peninsula", lat: 40.7398, lng: -74.0102 },
  { match: "gansevoort", lat: 40.7398, lng: -74.0102 },
  { match: "market 57", lat: 40.743, lng: -74.0095 },
  { match: "habitat garden", lat: 40.7286, lng: -74.0113 },
  { match: "tribeca", lat: 40.7205, lng: -74.0145 },
  { match: "chelsea waterside", lat: 40.7485, lng: -74.0073 },
]

function resolveLocation(text: string): { lat: number; lng: number; venue: string | null; exact: boolean } {
  const hay = text.toLowerCase()
  const pierM = hay.match(/\bpier\s+(\d+[a-z]?)\b/)
  if (pierM) {
    const key = `pier ${pierM[1]}`
    const c = PIER_COORDS[key]
    if (c) return { ...c, venue: `Pier ${pierM[1]}`, exact: true }
    return { ...PARK_CENTER, venue: `Pier ${pierM[1]}`, exact: false }
  }
  for (const n of NAMED_COORDS) {
    if (hay.includes(n.match)) {
      return { lat: n.lat, lng: n.lng, venue: n.match.replace(/\b\w/g, (c) => c.toUpperCase()), exact: true }
    }
  }
  return { ...PARK_CENTER, venue: null, exact: false }
}

function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map title + description to an interest category. HRP programming spans fitness, dance,
// live music, kids' science, nature/tours, films, and watch parties; default Hiking & parks.
function inferCategory(text: string): string {
  const hay = text.toLowerCase()
  if (/\byoga\b|\bpilates\b|\bmeditation\b|\bwellness\b/.test(hay)) return "Yoga & wellness"
  if (/\bsalsa\b|\bdance\b|\bdancing\b/.test(hay)) return "Dance"
  if (/\bjazz\b|\bblues\b|\bconcert\b|live music|\bband\b|\bperform\b/.test(hay)) return "Live music"
  if (/world cup|watch party|\bsoccer\b|\bbasketball\b|fishing|\bgame\b/.test(hay)) return "Sports & games"
  if (/\bfilm\b|\bcinema\b|\bmovie\b|screening/.test(hay)) return "Film & cinema"
  if (/\bfitness\b|\bworkout\b|bootcamp|\bhiit\b|conditioning|sculpt|ironstrength|\brun\b/.test(hay))
    return "Running & fitness"
  if (/\bscience\b|\bstem\b|wetlab|\bnature\b|\bbirding\b|estuary|\bgallery\b|\btour\b|walk/.test(hay))
    return "Hiking & parks"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Hiking & parks"
}

// Events that are not public-facing programming; we don't want these in the planner.
const EXCLUDE_PATTERNS = /board-of-directors|committee-meeting|advisory-council|public-hearing|rfp-|rfq-/i

type SitemapEntry = { url: string; slug: string; dateISO: string }

function parseSitemap(xmlOrHtml: string): SitemapEntry[] {
  const out: SitemapEntry[] = []
  for (const m of xmlOrHtml.matchAll(/https:\/\/hudsonriverpark\.org\/visit\/events\/event\/([a-z0-9-]+)\/?/gi)) {
    const slug = m[1]
    const dm = slug.match(/-([a-z]+)-(\d{1,2})-(\d{4})$/i)
    if (!dm) continue
    const mo = MONTHS[dm[1].toLowerCase()]
    if (mo === undefined) continue
    const day = Number(dm[2])
    const year = Number(dm[3])
    const dateISO = `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    out.push({ url: m[0].endsWith("/") ? m[0] : `${m[0]}/`, slug, dateISO })
  }
  return out
}

// Parse a 12-hour clock ("7:00 PM", "7 PM", "10:30 a.m.") into "HH:MM" 24h, or null.
function parseTimeFromText(text: string): string | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const pm = /p/i.test(m[3])
  if (pm && h !== 12) h += 12
  if (!pm && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

// Title-case a slug as a fallback when og:title is missing.
function deslugTitle(slug: string): string {
  return slug
    .replace(/-[a-z]+-\d{1,2}-\d{4}$/i, "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim()
}

async function buildEvent(entry: SitemapEntry): Promise<NormalizedEvent | null> {
  const html = await fetchViaProxy(entry.url, "og:title")
  const title = metaContent(html, "og:title") || deslugTitle(entry.slug)
  const description = metaContent(html, "og:description")
  const image = metaContent(html, "og:image")
  if (!title) return null

  // Time + location come from the human-readable description ("...Friday, July 10 at
  // 6:30 PM..." / "...off Pier 26..."). Default to a midday start if no time is stated, so
  // recurring daytime programming (drop-in fishing, galleries) still schedules.
  const haystack = `${title}. ${description || ""}`
  const time = (description && parseTimeFromText(description)) || "12:00"
  const startUtc = nyToUtcISO(entry.dateISO, time)
  if (!startUtc) return null

  const { lat, lng, venue, exact } = resolveLocation(haystack)

  return {
    id: deterministicId([SOURCE_NAME, entry.url]),
    title,
    description: description || null,
    source: SOURCE_NAME,
    source_event_id: entry.url,
    event_url: entry.url,
    venue_name: venue ? `${venue}, Hudson River Park` : "Hudson River Park",
    address: venue ? `${venue}, Hudson River Park, New York, NY` : "Hudson River Park, New York, NY",
    latitude: lat,
    longitude: lng,
    borough: "Manhattan",
    neighborhood: venue,
    category: inferCategory(haystack),
    tags: ["hudson river park", ...(venue ? [venue.toLowerCase()] : [])],
    organizer: "Hudson River Park",
    start_time: startUtc,
    end_time: null,
    // Park programming is free unless stated otherwise; the pages list no ticket price.
    price: "Free",
    currency: "USD",
    image_url: image || null,
    // Exact when we matched a known pier/named area; approximate on the park-center fallback.
    approximate_location: !exact,
  }
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

export const hudsonRiverParkSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    // 1) Collect every event URL from the sitemaps (via proxy; origin is blocked).
    const entries: SitemapEntry[] = []
    const seen = new Set<string>()
    for (const sm of EVENT_SITEMAPS) {
      try {
        const xml = await fetchViaProxy(`${ORIGIN}/${sm}`)
        for (const e of parseSitemap(xml)) {
          if (!seen.has(e.url)) {
            seen.add(e.url)
            entries.push(e)
          }
        }
      } catch {
        // skip a sitemap that fails; others may still resolve
      }
    }

    // 2) Filter to the ingest horizon by slug date, drop non-public items.
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startDay = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)
    const inHorizon = entries
      .filter((e) => !EXCLUDE_PATTERNS.test(e.slug))
      .filter((e) => {
        const d = new Date(`${e.dateISO}T12:00:00`)
        return d >= startDay && d <= endDay
      })
      .sort((a, b) => (a.dateISO < b.dateISO ? -1 : 1))
      .slice(0, MAX_DETAIL_FETCHES)

    // 3) Fetch detail pages (bounded concurrency) and build events.
    const built = await mapWithConcurrency(inHorizon, DETAIL_CONCURRENCY, buildEvent)
    return built.filter((e): e is NormalizedEvent => e !== null)
  },
}
