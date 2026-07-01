import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Governors Island (govisland.com) is a JS-rendered site with no server HTML, no JSON-LD,
// and no events feed — the events collection only appears after client-side hydration, and
// the origin isn't reliably fetchable server-side. We therefore render the events listing
// through the free r.jina.ai reader proxy, which returns the page as markdown. Each event
// is emitted as a single markdown link:
//
//   [![Image N](thumb) ## TITLE ##### [ORGANIZER] ##### Jul 4, 2026](https://.../events/slug)
//
// so we parse: title (## …), an optional organizer (##### …), and a trailing date token
// (##### …). BEST-EFFORT: the listing carries a date but NO start time, so we default to a
// midday start; entries whose trailing token isn't a real date (ongoing attractions like
// "Open daily" / "Monday-Thursday") are skipped since they can't be placed on a day plan.
const SOURCE_NAME = "Governors Island"
const LISTING_URL = "https://www.govisland.com/things-to-do/events-1"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// No start time is published on the listing; default to late morning (typical for island
// programming, which runs during public ferry hours).
const DEFAULT_TIME = "11:00"
// Governors Island is a single ~172-acre island; ferry access (Battery Maritime Building /
// Pier 11) is the same for every event, so one island-center coordinate is used for all.
// Marked approximate because the exact on-island spot varies and access is ferry-gated.
const ISLAND = { lat: 40.6895, lng: -74.0169 }

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function clean(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/%C3%A0/gi, "à")
    .replace(/%C3%ADa/gi, "ía")
    .replace(/\s+/g, " ")
    .trim()
}

// Parse a "Mon D, YYYY" token (e.g. "Jul 4, 2026") into a NY "YYYY-MM-DD" string, or null
// when the token isn't a concrete calendar date (recurring/ongoing descriptors).
function parseDateToken(token: string): string | null {
  const m = /\b([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(token)
  if (!m) return null
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (mo === undefined) return null
  const day = Number(m[2])
  const year = Number(m[3])
  if (day < 1 || day > 31) return null
  return `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map title + organizer to a canonical interest. Island programming skews toward art,
// nature/tours, and live music; default to Hiking & parks (it's an outdoor destination).
function inferCategory(text: string): string {
  const hay = text.toLowerCase()
  if (/\bbird\b|\btree\b|\bnature\b|\bgarden\b|\btour\b|\bwalk\b|\bhike\b/.test(hay)) return "Hiking & parks"
  if (/\bart\b|\bsculpture\b|\bgallery\b|\bexhibit|\bmural\b|\bartist\b|\binstallation\b/.test(hay))
    return "Art & galleries"
  if (/\bmusic\b|\bconcert\b|\bjazz\b|\bensemble\b|\bviolin\b|\bband\b|\bDJ\b/i.test(hay)) return "Live music"
  if (/\bcoffee\b|\bdinner\b|\bfood\b|\bbeach club\b|\btasting\b/.test(hay)) return "Food & dining"
  if (/\bkids\b|\bfamily\b|\bchildren\b|\bplay\b/.test(hay)) return "Family & kids"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Hiking & parks"
}

async function fetchListingMarkdown(): Promise<string> {
  const proxied = await fetch(`https://r.jina.ai/${LISTING_URL}`, {
    headers: { "User-Agent": BROWSER_UA },
  })
  if (!proxied.ok) throw new Error(`proxy HTTP ${proxied.status}`)
  return proxied.text()
}

export const governorsIslandSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const md = await fetchListingMarkdown()
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startDay = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    // Match each event link: image, then "## Title ##### … ##### Date", then the detail URL.
    const re =
      /\[!\[[^\]]*\]\([^)]*\)\s*([^\]]+?)\]\((https:\/\/www\.govisland\.com\/things-to-do\/events\/[^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(md)) !== null) {
      const inner = m[1]
      const url = m[2]
      if (seen.has(url)) continue

      // Split "## Title ##### Organizer ##### Date" on the heading markers.
      const parts = inner
        .split(/#{2,}/)
        .map((p) => clean(p))
        .filter(Boolean)
      if (parts.length < 2) continue

      const title = parts[0]
      const dateToken = parts[parts.length - 1]
      const organizer = parts.length >= 3 ? parts[1] : null

      const dateISO = parseDateToken(dateToken)
      if (!dateISO) continue // ongoing/undated attraction — skip
      const d = new Date(`${dateISO}T12:00:00`)
      if (d < startDay || d > endDay) continue

      const startUtc = nyToUtcISO(dateISO, DEFAULT_TIME)
      if (!startUtc) continue
      seen.add(url)

      const text = `${title} ${organizer || ""}`
      out.push({
        id: deterministicId([SOURCE_NAME, url]),
        title,
        description: organizer ? `Presented by ${organizer} on Governors Island.` : null,
        source: SOURCE_NAME,
        source_event_id: url,
        event_url: url,
        venue_name: "Governors Island",
        address: "Governors Island, New York, NY 10004",
        latitude: ISLAND.lat,
        longitude: ISLAND.lng,
        borough: "Manhattan",
        neighborhood: "Governors Island",
        category: inferCategory(text),
        tags: ["governors island", ...(organizer ? [organizer.toLowerCase()] : [])],
        organizer: organizer || "Governors Island",
        start_time: startUtc,
        end_time: null,
        price: "Free",
        currency: "USD",
        image_url: null,
        // Ferry-gated island; exact on-island spot varies and no start time is published.
        approximate_location: true,
      })
    }
    return out
  },
}
