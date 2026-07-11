import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyMidnightToday, nyToUtcISO, parseClockTo24h } from "./util"

// FAD Market (fadmarket.co) — a roving, seasonal fashion/art/design pop-up craft market that
// runs at several NYC venues (Empire Stores in Dumbo, St. Paul in Cobble Hill, Governors
// Island, The Seaport). It's a Squarespace site with a separate landing page per venue; there
// is no calendar feed, but each page's structured content is available at
// `<url>?format=json-pretty` (Squarespace JSON), which exposes `collection.title` and a
// `mainContent` HTML body.
//
// The body header (everything before the "11am - 6pm" time range) lists one or more weekend
// editions written as "Month D" or "Month D+D" (e.g. "July 11+12" = a Sat/Sun weekend). After
// the time range come the venue name, street, and city/zip, then the prose description. We emit
// one event per weekend edition, inferring the year relative to today (shared helper), and drop
// past editions via the horizon window. Locations are free-text (no coordinates), so events are
// marked approximate.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// The market landing pages to ingest. Add a slug here when FAD announces a new venue page.
const MARKET_SLUGS = ["summer-empire-stores", "summer-st-paul", "governors-island", "the-seaport-summer"]

const BOROUGHS = ["Brooklyn", "Manhattan", "Queens", "Bronx", "Staten Island"]

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Split the mainContent HTML into clean, non-empty text segments (the Squarespace body renders
// each line/field in its own block element, so tag boundaries make natural segment breaks).
function toSegments(mainContent: string): string[] {
  return mainContent
    .replace(/<[^>]*>/g, "\n")
    .split("\n")
    .map((s) => decodeEntities(s))
    .filter((s) => s.length > 1)
}

// Normalize an hour-only clock ("11am" -> "11:00 AM") and take the start of a range.
function startClock(rawTime: string): string {
  const first = rawTime.split(/\s*[-–—]\s*/)[0]?.trim() || ""
  const normalized = first.replace(/^(\d{1,2})\s*([ap])\.?m\.?$/i, "$1:00 $2m")
  return parseClockTo24h(normalized)
}

// Index of the "11am - 6pm" style time-range segment (separates the date header from the venue).
function findTimeRangeIndex(segments: string[]): number {
  return segments.findIndex((s) => /\d{1,2}\s*(?::\d{2})?\s*[ap]\.?m\.?\s*[-–—]\s*\d{1,2}\s*(?::\d{2})?\s*[ap]\.?m\.?/i.test(s))
}

type Edition = { startDate: string; endDate: string | null }

// Parse weekend-edition dates from the header segments. Each match is "Month D" or "Month D+D".
function parseEditions(headerSegments: string[], todayNY: Date): Edition[] {
  const editions: Edition[] = []
  const seen = new Set<string>()
  for (const seg of headerSegments) {
    const re = /([A-Z][a-z]+)\s+(\d{1,2})(?:\s*\+\s*(\d{1,2}))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      const startDate = monthDayToNyDate(m[1], Number(m[2]), todayNY)
      if (!startDate) continue
      const endDate = m[3] ? monthDayToNyDate(m[1], Number(m[3]), todayNY) : null
      if (seen.has(startDate)) continue
      seen.add(startDate)
      editions.push({ startDate, endDate })
    }
  }
  return editions
}

async function fetchMarket(slug: string): Promise<{ title: string; mainContent: string } | null> {
  try {
    const res = await fetch(`https://fadmarket.co/${slug}?format=json-pretty`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { collection?: { title?: string }; mainContent?: string }
    return { title: data.collection?.title || slug, mainContent: String(data.mainContent || "") }
  } catch {
    return null
  }
}

export const fadMarketSource: EventSource = {
  name: "FAD Market",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const todayNY = nyMidnightToday()
    const startWindow = todayNY.getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []

    for (const slug of MARKET_SLUGS) {
      const market = await fetchMarket(slug)
      if (!market || !market.mainContent) continue

      const segments = toSegments(market.mainContent)
      const timeIdx = findTimeRangeIndex(segments)
      if (timeIdx < 0) continue

      // Dates live before the time range; venue/address live after (until the prose starts).
      const editions = parseEditions(segments.slice(0, timeIdx), todayNY)
      if (editions.length === 0) continue

      const time = startClock(segments[timeIdx]) || "00:00"

      // Venue name is the first segment after the time range; the following short segments
      // (street, city/zip) form the address, until the long prose description begins.
      const venueName = segments[timeIdx + 1]?.trim() || null
      const addressParts: string[] = []
      for (let i = timeIdx + 2; i < segments.length; i++) {
        const seg = segments[i]
        // Stop at the description: a long, sentence-like segment.
        if (seg.length > 55 || /\bFAD Market\b/i.test(seg)) break
        addressParts.push(seg)
        if (/\bNY\s*\d{5}\b/.test(seg)) break // city/state/zip is the last address line
      }
      const address = addressParts.length ? [venueName, ...addressParts].filter(Boolean).join(", ") : null
      const borough = BOROUGHS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(address || "")) || null

      // A cleaner display title than the pipe-delimited SEO title Squarespace stores.
      const marketTitle = `FAD Market — ${venueName || market.title.split("|")[0].trim()}`

      for (const ed of editions) {
        const startISO = nyToUtcISO(ed.startDate, time)
        if (!startISO) continue
        const endISO = ed.endDate ? nyToUtcISO(ed.endDate, "23:59") : null

        // Keep the edition if any part of its run overlaps the horizon window.
        const startMs = new Date(startISO).getTime()
        const endMs = endISO ? new Date(endISO).getTime() : startMs
        if (endMs < startWindow || startMs > endWindow) continue

        out.push({
          id: deterministicId(["FAD Market", slug, ed.startDate]),
          title: marketTitle,
          description: null,
          source: "FAD Market",
          source_event_id: null,
          event_url: `https://fadmarket.co/${slug}`,
          venue_name: venueName,
          address,
          latitude: null,
          longitude: null,
          borough,
          neighborhood: null,
          category: "Markets & shopping",
          tags: ["Markets & shopping", "FAD Market"],
          organizer: "FAD Market",
          start_time: startISO,
          end_time: endISO,
          price: "Free",
          currency: "USD",
          image_url: null,
          // Only a free-text address is published (no coordinates).
          approximate_location: true,
        })
      }
    }

    return out
  },
}
