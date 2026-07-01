import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Hudson Yards (hudsonyardsnewyork.com) — the Far West Side development's events: concerts,
// fitness classes, kids' programming, seasonal happenings, and gallery/observation-deck
// events. It's a Drupal site that renders the calendar client-side with no JSON API and no
// events feed, so we render the listing through the free r.jina.ai reader proxy. Each event
// is a markdown heading followed by a date block:
//
//   ## [Nathan's Famous Hot Dog Eating Competition Weigh-In](https://…/events/…)
//    Date: July 3, 2026
//    Time: 12:00 pm ~ 1:00 pm
//
// IMPORTANT: the listing mixes two kinds of entries. Single-day happenings carry a concrete
// "Date:" + "Time:" and are real, placeable events. The rest are multi-day "Start:/End:"
// ranges that are overwhelmingly retail promotions ("Shop Red, White & Blue at H&M",
// "Psycho Bunny Golf Styles") with no start time — not things a person plans a day around.
// We therefore ingest ONLY the single-day timed events and skip the open-ended ranges.
const SOURCE_NAME = "Hudson Yards"
const LISTING_URL = "https://www.hudsonyardsnewyork.com/see-do/events"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// Hudson Yards is a single compact development; one coordinate (The Vessel / plaza) serves
// all events, which cluster around 20 Hudson Yards and the public square.
const CENTER = { lat: 40.7539, lng: -74.0014 }

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

// "July 3, 2026" -> "2026-07-03" (or null).
function parseDate(token: string): string | null {
  const m = /\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/.exec(token)
  if (!m) return null
  const mo = MONTHS[m[1].toLowerCase()]
  if (mo === undefined) return null
  const day = Number(m[2])
  if (day < 1 || day > 31) return null
  return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// "12:00 pm" / "1:00 pm" -> "HH:MM" 24-hour (or null).
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

function inferCategory(text: string): string {
  const hay = text.toLowerCase()
  if (/\bconcert\b|\bmusic\b|\bjazz\b|\bband\b|\bDJ\b|\blive\b/i.test(hay)) return "Live music"
  if (/\byoga\b|\bfitness\b|\bworkout\b|\bwellness\b|\brun\b|\bbootcamp\b/.test(hay)) return "Running & fitness"
  if (/\bkids\b|\bfamily\b|\bchildren\b/.test(hay)) return "Family & kids"
  if (/\bfood\b|\bdining\b|\btasting\b|\bhot dog\b|\beating\b/.test(hay)) return "Food & dining"
  if (/\bart\b|\bgallery\b|\bexhibit|\binstallation\b/.test(hay)) return "Art & galleries"
  if (/\bmarket\b|\bshop\b|\bshopping\b|\bpop-?up\b/.test(hay)) return "Markets & shopping"
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

export const hudsonYardsSource: EventSource = {
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

    // Heading anchor: "## [Title](https://…/events/slug)".
    const headingRe = /^#{1,3}\s*\[([^\]]+)\]\((https:\/\/www\.hudsonyardsnewyork\.com\/events\/[^)]+)\)/

    for (let i = 0; i < lines.length; i++) {
      const hm = headingRe.exec(lines[i])
      if (!hm) continue
      const title = clean(hm[1])
      const url = hm[2]
      if (!title || seen.has(url)) continue

      // Look ahead to the next heading; capture Date/Time, and bail if it's a Start/End range.
      let dateISO: string | null = null
      let time: string | null = null
      let isRange = false
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const l = lines[j]
        if (!l) continue
        if (headingRe.test(l)) break // reached the next event
        if (/^Start:/i.test(l) || /^End:/i.test(l)) isRange = true
        const dm = /^Date:\s*(.+)$/i.exec(l)
        if (dm && !dateISO) dateISO = parseDate(dm[1])
        const tm = /^Time:\s*(.+)$/i.exec(l)
        if (tm && !time) time = parseTime(tm[1])
      }

      // Only keep single-day timed happenings; skip open-ended retail/exhibition ranges.
      if (isRange && !dateISO) continue
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
        venue_name: "Hudson Yards",
        address: "20 Hudson Yards, New York, NY 10001",
        latitude: CENTER.lat,
        longitude: CENTER.lng,
        borough: "Manhattan",
        neighborhood: "Hudson Yards",
        category: inferCategory(title),
        tags: ["hudson yards"],
        organizer: "Hudson Yards",
        start_time: startUtc,
        end_time: null,
        // Real coordinates and a real start time when present; default noon only as a
        // fallback. Location is exact (single development).
        price: null,
        currency: "USD",
        image_url: null,
        approximate_location: false,
      })
    }
    return out
  },
}
