import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Union Square Partnership (unionsquarenyc.org) — the district's public programming:
// Lunchtime Jazz, Movies in the Square, fitness, seasonal markets, and tours around
// Union Square Park. The site is a Squarespace build whose events live in a custom
// "featured-events" collection that renders only after client hydration and exposes no
// usable JSON (the ?format=json endpoint returns the page chrome, not the events). We
// therefore render the listing through the free r.jina.ai reader proxy, which returns
// markdown where each event appears as:
//
//   [Lunchtime Jazz: July 2](https://www.unionsquarenyc.org/featured-events/jazz-july2)
//   July 2, 2026
//   12:00 PM – 2:00 PM 12:00 – 14:00 12:00 PM – 2:00 PM
//
// so we anchor on the TEXT link (not the image link — its alt text reuses stale thumbnail
// captions like "August 20" on a July event), then read the following date and start time.
const SOURCE_NAME = "Union Square Partnership"
const LISTING_URL = "https://www.unionsquarenyc.org/events"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// Union Square Park — every event is in/around the park, so one coordinate serves all.
const PARK = { lat: 40.7359, lng: -73.9911 }

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

function clean(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

// "July 2, 2026" -> "2026-07-02" (or null when not a concrete date).
function parseDate(token: string): string | null {
  const m = /\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/.exec(token)
  if (!m) return null
  const mo = MONTHS[m[1].toLowerCase()]
  if (mo === undefined) return null
  const day = Number(m[2])
  if (day < 1 || day > 31) return null
  return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// "12:00 PM" / "7:30 PM" -> "HH:MM" 24-hour. Returns null when no time is present.
function parseTime(token: string): string | null {
  const m = /\b(\d{1,2}):(\d{2})\s*([AaPp][Mm])\b/.exec(token)
  if (!m) return null
  let h = Number(m[1]) % 12
  if (/[Pp]/.test(m[3])) h += 12
  return `${String(h).padStart(2, "0")}:${m[2]}`
}

function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map a title to a canonical interest. Union Square's programming skews music/film/fitness.
function inferCategory(text: string): string {
  const hay = text.toLowerCase()
  if (/\bjazz\b|\bmusic\b|\bconcert\b|\bband\b|\bDJ\b/i.test(hay)) return "Live music"
  if (/\bmovie|\bfilm\b|\bcinema\b|\bscreening\b/.test(hay)) return "Film & cinema"
  if (/\byoga\b|\bfitness\b|\bworkout\b|\bwellness\b|\bmeditation\b/.test(hay)) return "Yoga & wellness"
  if (/\bmarket\b|\bgreenmarket\b|\bvendor\b/.test(hay)) return "Markets & shopping"
  if (/\btour\b|\bwalk\b|\bgarden\b|\bpark\b/.test(hay)) return "Hiking & parks"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Others"
}

async function fetchListingMarkdown(): Promise<string> {
  const proxied = await fetch(`https://r.jina.ai/${LISTING_URL}`, { headers: { "User-Agent": BROWSER_UA } })
  if (!proxied.ok) throw new Error(`proxy HTTP ${proxied.status}`)
  return proxied.text()
}

export const unionSquareSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const md = await fetchListingMarkdown()
    const lines = md.split("\n").map((l) => l.trim())

    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startDay = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    // Text-link anchor: "[Title](…/featured-events/slug)" — the leading char after "[" must
    // not be "!" so we skip the image links whose alt captions are unreliable.
    const linkRe = /^\[([^!\]][^\]]*)\]\((https:\/\/www\.unionsquarenyc\.org\/featured-events\/[^)]+)\)$/

    for (let i = 0; i < lines.length; i++) {
      const lm = linkRe.exec(lines[i])
      if (!lm) continue
      const title = clean(lm[1])
      const url = lm[2]
      if (!title || seen.has(url)) continue

      // Scan the next few non-empty lines for the date and start time.
      let dateISO: string | null = null
      let time: string | null = null
      for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
        if (!lines[j]) continue
        if (!dateISO) dateISO = parseDate(lines[j])
        if (!time) time = parseTime(lines[j])
        if (dateISO && time) break
      }
      if (!dateISO) continue

      const d = new Date(`${dateISO}T12:00:00`)
      if (d < startDay || d > endDay) continue

      const startUtc = nyToUtcISO(dateISO, time || "12:00")
      if (!startUtc) continue
      seen.add(url)

      out.push({
        id: deterministicId([SOURCE_NAME, url]),
        title,
        description: null,
        source: SOURCE_NAME,
        source_event_id: url,
        event_url: url,
        venue_name: "Union Square Park",
        address: "Union Square, New York, NY 10003",
        latitude: PARK.lat,
        longitude: PARK.lng,
        borough: "Manhattan",
        neighborhood: "Union Square",
        category: inferCategory(title),
        tags: ["union square"],
        organizer: "Union Square Partnership",
        start_time: startUtc,
        end_time: null,
        // Real park coordinates and (usually) a real start time, so treat as exact.
        price: "Free",
        currency: "USD",
        image_url: null,
        approximate_location: false,
      })
    }
    return out
  },
}
