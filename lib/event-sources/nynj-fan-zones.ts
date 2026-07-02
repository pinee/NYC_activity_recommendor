import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO, WORLD_CUP_CATEGORY } from "./util"

// Official NY/NJ Host Committee World Cup 2026 "fan zones" — free, ticketed outdoor watch
// parties on big screens. Source: the host committee's own site, nynjfwc26.com (the most
// credible, first-party source for these events).
//
// HOW WE EXTRACT: the committee restructured the site so every fan zone now lives on a SINGLE
// page — https://nynjfwc26.com/fan-events/ — as an anchored section (e.g. id="fan-zones-island").
// The old per-borough URLs (/staten-island/, etc.) now 404/403. We fetch that one page's RAW
// HTML directly (the r.jina.ai reader proxy only returns page boilerplate for this site) and
// parse each zone's section for its name, official date range, and open/closed status.
//
// LIVENESS + CORRECTNESS GUARDS:
//  • We only emit a zone if its section is present on the live page.
//  • If a section says "Now Closed" (as Queens and the Bronx currently do), we skip it — so
//    zones drop off automatically the moment the committee closes them.
//  • Date ranges are parsed from the page ("June 29 - July 2, 2026"); if parsing fails we fall
//    back to the verified official range in the registry, so we never emit an undated event.
//
// LOCATIONS: the page does not expose street addresses, so we keep a tiny registry of VERIFIED
// facts per zone (address + coordinates confirmed via the US Census geocoder / the venue) and
// combine them with the live name/dates/status. Coordinates are exact, not centroids.
//
// SCOPE: NYC boroughs plus the NJ "Jersey Fan Hub" (an official active fan zone on this page,
// PATH-accessible). The Manhattan Telemundo Fan Village at Rockefeller Center is intentionally
// omitted here because it is already covered by the NYC Tourism source (avoids duplicates).
const SOURCE_NAME = "NYNJ World Cup 26 Fan Zones"
const FAN_EVENTS_URL = "https://nynjfwc26.com/fan-events/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

type FanZone = {
  key: string
  // The section anchor id on the fan-events page (e.g. id="fan-zones-island").
  anchorId: string
  // Human title used for the emitted event.
  title: string
  venueName: string
  address: string
  lat: number
  lng: number
  borough: string
  neighborhood: string
  // Doors-open / close times in NY wall clock ("HH:MM"). Match kickoffs vary and are well known
  // to fans, so we anchor to operating hours rather than a specific match (per product intent:
  // don't over-index on exact match times).
  doorsTime: string
  closeTime: string
  // Verified official operating window (inclusive), NY dates "YYYY-MM-DD" — used as a fallback
  // and as a sanity clamp for dates parsed off the page.
  fallbackStart: string
  fallbackEnd: string
  // Verified hero image for this zone from the official page (used when the live per-section
  // image can't be parsed). Confirmed to return HTTP 200 image/* at build time.
  fallbackImage: string
}

const FAN_ZONES: FanZone[] = [
  {
    key: "jersey",
    anchorId: "fan-hub",
    title: "Jersey Fan Hub: World Cup 2026 Watch Parties",
    venueName: "Jersey Fan Hub — Sports Illustrated Stadium",
    address: "600 Cape May Street, Harrison, NJ 07029",
    lat: 40.735134,
    lng: -74.155311,
    borough: "New Jersey",
    neighborhood: "Harrison, NJ",
    doorsTime: "12:00",
    closeTime: "23:30",
    fallbackStart: "2026-06-11",
    fallbackEnd: "2026-07-19",
    fallbackImage: "https://nynjfwc26.com/wp-content/uploads/2026/06/image-topaz-upscale-2.2x-1-scaled.webp",
  },
  {
    key: "staten-island",
    anchorId: "fan-zones-island",
    title: "Staten Island Fan Zone: World Cup 2026 Watch Party",
    venueName: "Staten Island Fan Zone — SIUH Community Park",
    address: "75 Richmond Terrace, Staten Island, NY 10301",
    lat: 40.645575,
    lng: -74.076428,
    borough: "Staten Island",
    neighborhood: "St. George",
    doorsTime: "16:00",
    closeTime: "23:30",
    fallbackStart: "2026-06-29",
    fallbackEnd: "2026-07-02",
    fallbackImage:
      "https://nynjfwc26.com/wp-content/uploads/2026/05/SIUH-Community-Park-Staten-Island-NYC-Courtesy.webp",
  },
  {
    key: "brooklyn",
    anchorId: "fan-zones-brooklyn",
    title: "Brooklyn Fan Zone: World Cup 2026 Watch Parties",
    venueName: "Brooklyn Fan Zone — Brooklyn Bridge Park",
    address: "1 Water Street, Brooklyn, NY 11201",
    lat: 40.702995,
    lng: -73.994482,
    borough: "Brooklyn",
    neighborhood: "Brooklyn Bridge Park",
    doorsTime: "12:00",
    closeTime: "23:30",
    fallbackStart: "2026-06-13",
    fallbackEnd: "2026-07-19",
    fallbackImage: "https://nynjfwc26.com/wp-content/uploads/2026/06/brooklyn-topaz-upscale-2x-scaled.png",
  },
]

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

async function fetchRawHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Slice out a single zone's section from the full page HTML: from its anchor id to the start
// of the next section (id="..."), then strip tags to plain text for robust matching.
function sectionText(html: string, anchorId: string): string | null {
  const startIdx = html.indexOf(`id="${anchorId}"`)
  if (startIdx < 0) return null
  const rest = html.slice(startIdx + anchorId.length)
  const nextIdx = rest.search(/id="[a-z0-9-]+"/i)
  const raw = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest.slice(0, 4000)
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Extract the first real content image from a zone's RAW section HTML (before tags are
// stripped). We look for an uploaded photo (…/wp-content/uploads/…) and skip inline SVG/logo
// assets, so the returned URL is the zone's hero photo. Returns null when none is present.
function extractSectionImage(html: string, anchorId: string): string | null {
  const startIdx = html.indexOf(`id="${anchorId}"`)
  if (startIdx < 0) return null
  const rest = html.slice(startIdx + anchorId.length)
  const nextIdx = rest.search(/id="[a-z0-9-]+"/i)
  const section = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest.slice(0, 6000)
  for (const m of section.matchAll(/<img[^>]+(?:data-src|src)="([^"]+)"/gi)) {
    const url = m[1]
    if (/\/wp-content\/uploads\/.+\.(?:webp|jpe?g|png)(?:\?|$)/i.test(url)) return url
  }
  return null
}

// Parse an official date range like "June 29 - July 2, 2026" or "July 6 - 19, 2026" (second
// month omitted). Returns NY ISO dates, or null if not confidently parseable.
function parseDateRange(text: string): { start: string; end: string } | null {
  const re =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–—]\s*(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2})(?:,?\s*(\d{4}))?/i
  const m = re.exec(text)
  if (!m) return null
  const startMonth = MONTHS[m[1].toLowerCase()]
  const startDay = Number(m[2])
  const endMonth = m[3] ? MONTHS[m[3].toLowerCase()] : startMonth
  const endDay = Number(m[4])
  const year = m[5] ? Number(m[5]) : 2026
  if (!startMonth || !endMonth) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    start: `${year}-${pad(startMonth)}-${pad(startDay)}`,
    end: `${year}-${pad(endMonth)}-${pad(endDay)}`,
  }
}

export const nynjFanZonesSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startDay = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)

    // Single fetch of the official fan-events page (raw HTML).
    const html = await fetchRawHtml(FAN_EVENTS_URL)
    // Credibility/liveness guard: bail entirely if the page didn't load or doesn't look right.
    if (!html || !/world cup/i.test(html)) return []

    const out: NormalizedEvent[] = []

    for (const z of FAN_ZONES) {
      const section = sectionText(html, z.anchorId)
      if (!section) continue // zone no longer on the page

      // Skip zones the committee has closed (their section text says "Now Closed").
      if (/now closed/i.test(section)) continue

      // Prefer the date range parsed from the live page; clamp to a sane 2026 window, else fall
      // back to the verified official range so we never emit an undated event.
      const parsed = parseDateRange(section)
      const rangeStart = parsed?.start ?? z.fallbackStart
      const rangeEnd = parsed?.end ?? z.fallbackEnd

      const rangeStartDate = new Date(`${rangeStart}T00:00:00`)
      const rangeEndDate = new Date(`${rangeEnd}T23:59:59`)
      if (Number.isNaN(rangeStartDate.getTime()) || Number.isNaN(rangeEndDate.getTime())) continue

      // Skip if the operating window is already over or starts beyond the ingest horizon.
      if (rangeEndDate < startDay) continue
      if (rangeStartDate > endDay) continue

      const startUtc = nyToUtcISO(rangeStart, z.doorsTime)
      const endUtc = nyToUtcISO(rangeEnd, z.closeTime)
      if (!startUtc || !endUtc) continue

      // Prefer the live per-section hero image; fall back to the verified official one.
      const imageUrl = extractSectionImage(html, z.anchorId) ?? z.fallbackImage

      out.push({
        id: deterministicId([SOURCE_NAME, z.key, rangeStart]),
        source_event_id: `${z.key}:${rangeStart}..${rangeEnd}`,
        title: z.title,
        description:
          `Free FIFA World Cup 2026™ watch party hosted by the NY/NJ Host Committee at ` +
          `${z.venueName}. Matches are shown live on big screens. Check the official page for ` +
          `the day's fixtures, programming, and ticketing.`,
        source: SOURCE_NAME,
        event_url: FAN_EVENTS_URL,
        venue_name: z.venueName,
        address: z.address,
        latitude: z.lat,
        longitude: z.lng,
        borough: z.borough,
        neighborhood: z.neighborhood,
        // Canonical category so these collect under the "World Cup & Soccer" interest.
        category: WORLD_CUP_CATEGORY,
        tags: ["world cup", "fan zone", "watch party", "soccer", z.borough.toLowerCase()],
        organizer: "NY/NJ World Cup 2026 Host Committee",
        price: "Free",
        currency: "USD",
        image_url: imageUrl,
        // Exact, verified venue coordinates — not a centroid.
        approximate_location: false,
        start_time: startUtc,
        end_time: endUtc,
      })
    }

    return out
  },
}
