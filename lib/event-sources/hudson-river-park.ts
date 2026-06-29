import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyToUtcISO, parseClockTo24h } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Hudson River Park's events page is server-rendered HTML (no public API; the Tribe REST
// endpoint is disabled). Each event is a ".hrpkcard" with a title + link, a date/time
// line, and the pier it happens on. We parse those cards directly.
const SOURCE_NAME = "Hudson River Park"
const PAGE_URL = "https://hudsonriverpark.org/visit/events/"
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

// Precise coordinates for Hudson River Park's piers/segments. The park is a thin ribbon
// along the Hudson from Tribeca to 59th St, so each pier is a fixed, well-known point —
// mapping the pier name to coordinates makes travel times exact.
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

function resolvePier(pier: string | null): { lat: number; lng: number; exact: boolean } {
  const hay = (pier || "").toLowerCase()
  for (const [name, c] of Object.entries(PIER_COORDS)) {
    if (hay.includes(name)) return { ...c, exact: true }
  }
  return { ...PARK_CENTER, exact: false }
}

function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map a title to an interest category. HRP programming is parks/nature, fitness, kids'
// science, tours, films, and watch parties; default to Hiking & parks.
function inferCategory(title: string): string {
  const hay = title.toLowerCase()
  if (/\byoga\b|\bpilates\b|\bmeditation\b/.test(hay)) return "Yoga & wellness"
  if (/\bworld cup\b|watch party|soccer|basketball|\bgame\b/.test(hay)) return "Sports & games"
  if (/\bfilm\b|\bcinema\b|\bmovie\b|screening/.test(hay)) return "Film & cinema"
  if (/\bfitness\b|\bworkout\b|bootcamp|\brun\b/.test(hay)) return "Running & fitness"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Hiking & parks"
}

function parseCards(html: string, todayNY: Date): NormalizedEvent[] {
  const chunks = html.split(/<div class="hrpkcard--title">/).slice(1)
  const out: NormalizedEvent[] = []
  const now = Date.now()

  for (const c of chunks) {
    const url = (c.match(/href="([^"]+)"/) || [])[1] || null
    const title = clean((c.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1])
    const dateLine = clean((c.match(/hrpkcard--details-dates">([\s\S]*?)<\/div>/) || [])[1])
    const pier = clean((c.match(/hrpkcard--details-pier">([\s\S]*?)<\/div>/) || [])[1]) || null
    if (!title || !url) continue

    // "Thursday, Jun 25 11:00 AM - 9:00 PM"  (end time optional)
    const dm = dateLine.match(
      /[A-Za-z]+,?\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}\s*[AP]M)(?:\s*-\s*(\d{1,2}:\d{2}\s*[AP]M))?/,
    )
    if (!dm) continue
    const date = monthDayToNyDate(dm[1], Number(dm[2]), todayNY)
    if (!date) continue
    const startUtc = nyToUtcISO(date, parseClockTo24h(dm[3]))
    if (!startUtc) continue
    const endUtc = dm[4] ? nyToUtcISO(date, parseClockTo24h(dm[4])) : null
    const effectiveEnd = endUtc ? new Date(endUtc).getTime() : new Date(startUtc).getTime()
    if (effectiveEnd < now) continue

    const { lat, lng, exact } = resolvePier(pier)

    out.push({
      id: deterministicId([SOURCE_NAME, url, date]),
      title,
      description: null,
      source: SOURCE_NAME,
      source_event_id: `${url}#${date}`,
      event_url: url,
      venue_name: pier ? `${pier}, Hudson River Park` : "Hudson River Park",
      address: pier ? `${pier}, Hudson River Park, New York, NY` : "Hudson River Park, New York, NY",
      latitude: lat,
      longitude: lng,
      borough: "Manhattan",
      neighborhood: pier,
      category: inferCategory(title),
      tags: ["hudson river park", ...(pier ? [pier.toLowerCase()] : [])],
      organizer: "Hudson River Park",
      start_time: startUtc,
      end_time: endUtc,
      // Park programming is free unless stated otherwise; the page lists no price.
      price: "Free",
      currency: "USD",
      image_url: null,
      // Exact when we matched a known pier; approximate only on the park-center fallback.
      approximate_location: !exact,
    })
  }
  return out
}

export const hudsonRiverParkSource: EventSource = {
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
