import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, isoDatePart } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// pulsd.com NYC daily calendar. pulsd is a client-rendered app, but its calendar loads
// events from a server-rendered XHR fragment endpoint:
//   /new-york/calendar/refresh_today?date=MM/DD/YYYY
// That fragment embeds clean schema.org/SaleEvent microdata (name, description, a Place
// with a full street address, ISO startDate/endDate, and an Offer with price + url), so
// we parse the microdata rather than scraping free text.
//
// We intentionally use ONLY the dated `refresh_today` endpoint (real scheduled events),
// not `refresh_ongoing` (evergreen, date-less promotional deals) which don't fit the
// app's scheduled-event model.
const SOURCE_NAME = "Pulsd"
const BASE = "https://pulsd.com/new-york/calendar/refresh_today"
const REFERER = "https://pulsd.com/new-york/calendar/daily"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// How many days of the calendar to walk (one fetch per day). Capped independently of the
// ingest horizon so we never fan out into too many requests.
const MAX_DAYS = 14

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Read an itemprop's `content` attribute from an HTML block, tolerating either attribute
// order (`content=.. itemprop=..` or `itemprop=.. content=..`).
function getProp(block: string, prop: string): string | null {
  const a = new RegExp(`content=["']([^"']*)["'][^>]*itemprop=["']${prop}["']`, "i").exec(block)
  if (a) return decodeEntities(a[1])
  const b = new RegExp(`itemprop=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i").exec(block)
  if (b) return decodeEntities(b[1])
  return null
}

// pulsd's date query param for a given offset of days from today (NY time). We use the
// ISO "YYYY-MM-DD" form: the "MM/DD/YYYY" form 500s for the current day and silently
// returns nothing for some future days, whereas ISO is reliable across the horizon.
function nyDateParam(offsetDays: number): string {
  const nowNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
  nowNY.setDate(nowNY.getDate() + offsetDays)
  const mm = String(nowNY.getMonth() + 1).padStart(2, "0")
  const dd = String(nowNY.getDate()).padStart(2, "0")
  return `${nowNY.getFullYear()}-${mm}-${dd}`
}

// Format pulsd's numeric price ("39.0") as a human label ("$39"); keep cents when present.
function formatPrice(raw: string | null): string | null {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n === 0) return "Free"
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

// pulsd-specific category cues (checked before the generic interest keyword map), since
// pulsd is heavy on food/nightlife/wellness deals.
function inferCategory(title: string, description: string): string {
  const hay = `${title} ${description}`.toLowerCase()
  if (/\b(open bar|rooftop party|nightclub|night club|club|after ?party|bottle service)\b/.test(hay)) return "Nightlife"
  if (/\b(brunch|bottomless|dinner|tasting|prix fixe|course meal|eats|food|restaurant|wine|cocktail|drinks?)\b/.test(hay))
    return "Food & dining"
  if (/\b(spa|massage|facial|sauna|wellness|beauty|nails?|manicure|pedicure)\b/.test(hay)) return "Yoga & wellness"
  if (/\b(yoga|pilates|meditation)\b/.test(hay)) return "Yoga & wellness"
  if (/\b(workout|fitness|bootcamp|gym|cycling|spin)\b/.test(hay)) return "Running & fitness"
  if (/\b(comedy|stand ?up|improv)\b/.test(hay)) return "Comedy"
  if (/\b(concert|live music|dj|band|jazz)\b/.test(hay)) return "Live music"
  if (/\b(baseball|cyclones|game|sports|pickleball)\b/.test(hay)) return "Sports & games"
  // Fall back to the shared interest keyword map, then to a sensible default.
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hay.includes(k))) return interest
  }
  return "Food & dining"
}

// Parse the SaleEvent microdata blocks out of one day's HTML fragment.
function parseDay(html: string): NormalizedEvent[] {
  const blocks = html.split(/<div itemscope itemtype=["']https?:\/\/schema\.org\/SaleEvent["']/i).slice(1)
  const out: NormalizedEvent[] = []

  for (const raw of blocks) {
    // Limit each block to before the next top-level item to avoid bleed.
    const block = raw.split(/<div itemscope itemtype=["']https?:\/\/schema\.org\/(?:SaleEvent|Product)["']/i)[0]

    const title = getProp(block, "name")
    const startDate = getProp(block, "startDate")
    if (!title || !startDate) continue

    const description = getProp(block, "description")

    // Venue + address live in the nested Place block.
    const placeMatch = block.match(/itemprop=["']location["'][\s\S]*?<\/div>/i)
    const placeBlock = placeMatch ? placeMatch[0] : ""
    const venue = getProp(placeBlock, "name")
    const address = getProp(placeBlock, "address")

    // Price + canonical url live in the nested Offer block.
    const offerMatch = block.match(/itemprop=["']offers["'][\s\S]*?<\/div>/i)
    const offerBlock = offerMatch ? offerMatch[0] : ""
    const price = formatPrice(getProp(offerBlock, "price"))
    const url = getProp(offerBlock, "url") || getProp(block, "url")

    const endDate = getProp(block, "endDate")
    // startDate/endDate are already UTC ISO ("...Z"); use directly.
    const startISO = /\dZ?$/.test(startDate) ? new Date(startDate).toISOString() : null
    if (!startISO) continue
    const endISO = endDate ? new Date(endDate).toISOString() : null
    if (new Date(startISO).getTime() < Date.now() - 12 * 3600000) continue // drop long-past

    const category = inferCategory(title, description || "")

    out.push({
      id: deterministicId([SOURCE_NAME, url || title, isoDatePart(startISO) || ""]),
      title,
      description,
      source: SOURCE_NAME,
      source_event_id: url || title,
      event_url: url,
      venue_name: venue,
      // Full street address ("1904 Surf Avenue, Brooklyn, NY 11224") geocodes precisely
      // during ingest; we leave coordinates null here for the geocoder to fill.
      address: address || (venue ? `${venue}, New York, NY` : null),
      latitude: null,
      longitude: null,
      borough: null,
      neighborhood: null,
      category,
      tags: ["pulsd", "deal"],
      organizer: null,
      start_time: startISO,
      end_time: endISO,
      price,
      currency: price && price !== "Free" ? "USD" : null,
      image_url: null,
      // No coordinates provided; the ingest geocoder will fill them from the street
      // address and flag the result approximate, consistent with our other sources.
      approximate_location: false,
    })
  }
  return out
}

export const pulsdSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const days = Math.min(horizonDays, MAX_DAYS)
    const collected: NormalizedEvent[] = []
    const seen = new Set<string>()

    for (let i = 0; i < days; i++) {
      const date = nyDateParam(i)
      try {
        const res = await fetch(`${BASE}?date=${date}`, {
          headers: {
            Accept: "text/html, */*; q=0.01",
            "User-Agent": BROWSER_UA,
            "X-Requested-With": "XMLHttpRequest",
            Referer: REFERER,
          },
        })
        if (!res.ok) continue
        const html = await res.text()
        for (const ev of parseDay(html)) {
          if (seen.has(ev.id)) continue
          seen.add(ev.id)
          collected.push(ev)
        }
      } catch {
        // Skip a failed day rather than aborting the whole source.
        continue
      }
    }
    return collected
  },
}
