import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyMidnightToday, nyToUtcISO, parseClockTo24h } from "./util"

// NYC DOT Bike Events (nyc.gov/html/dot/html/bicyclists/bike-events.shtml) — free city-run
// cycling programming: helmet fittings & giveaways, Bike Month (May) and Biketober (October)
// events, and self-guided rides. It's a plain static .shtml page (no API, no JSON-LD), but the
// upcoming events live in a simple HTML table with fixed columns:
//   Event | Date | Time | Borough | Location
// so we parse the table rows directly. Dates are year-less ("Saturday, July 11") and times are
// ranges ("9am to 1pm" / "9am to 11:30am"), which we normalize into a NYC wall-clock start.
//
// The page gives a borough + a free-text location (often "Venue (street address)") but no
// coordinates, so we surface the borough and address and mark the location approximate.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const URL = "https://www.nyc.gov/html/dot/html/bicyclists/bike-events.shtml"

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December"

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
}

// "9am" | "9:30am" | "11:30am" -> "HH:MM" (24h). Normalizes hour-only clocks so the
// shared HH:MM parser accepts them. Returns "" when unparseable (treated as midnight).
function normalizeClock(raw: string): string {
  const cleaned = raw.trim().replace(/^(\d{1,2})\s*([ap]\.?m\.?)$/i, "$1:00 $2")
  return parseClockTo24h(cleaned)
}

// Split "9am to 1pm" / "9am–11:30am" into its start clock.
function startClock(timeRange: string): string {
  const first = timeRange.split(/\s*(?:to|–|-|—)\s*/i)[0] || ""
  return normalizeClock(first)
}

// Pull "Venue (123 Street, Borough, NY 11361)" apart into { venue, address }.
function splitLocation(raw: string): { venue: string | null; address: string | null } {
  const text = raw.trim()
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text)
  if (m) {
    return { venue: m[1].trim() || null, address: m[2].trim() || null }
  }
  return { venue: text || null, address: text || null }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export const nycDotBikeSource: EventSource = {
  name: "NYC DOT Bike Events",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const html = await fetchText(URL)
    if (!html) return []

    const todayNY = nyMidnightToday()
    const startWindow = todayNY.getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    const dateRe = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})\\b`, "i")

    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
      // Data rows have Event, Date, Time, Borough, Location. Skip the header row and any
      // malformed/short rows.
      if (cells.length < 5) continue
      const [title, dateText, timeText, boroughText, locationText] = cells
      if (!title || /^event$/i.test(title)) continue

      const dm = dateRe.exec(dateText)
      if (!dm) continue
      const date = monthDayToNyDate(dm[1], Number(dm[2]), todayNY)
      if (!date) continue

      const time = startClock(timeText) || "00:00"
      const startISO = nyToUtcISO(date, time)
      if (!startISO) continue
      const startMs = new Date(startISO).getTime()
      if (startMs < startWindow || startMs > endWindow) continue

      const { venue, address } = splitLocation(locationText)
      const borough = (boroughText || "").trim() || null

      out.push({
        id: deterministicId(["NYC DOT Bike Events", title, date]),
        title,
        description: null,
        source: "NYC DOT Bike Events",
        source_event_id: null,
        event_url: URL,
        venue_name: venue,
        address,
        latitude: null,
        longitude: null,
        borough,
        neighborhood: null,
        category: "Cycling",
        tags: ["Cycling", "NYC DOT"],
        organizer: "NYC Department of Transportation",
        start_time: startISO,
        end_time: null,
        price: null,
        currency: "USD",
        image_url: null,
        // Only a borough + free-text address is published (no coordinates), so travel-time
        // estimates for these events are approximate.
        approximate_location: true,
      })
    }

    return out
  },
}
