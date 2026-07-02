import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO, monthDayToNyDate, WORLD_CUP_CATEGORY } from "./util"

// Official NY/NJ Host Committee World Cup 2026 borough "fan zones" — free, ticketed outdoor
// watch parties on big screens. Source: the host committee's own site, nynjfwc26.com (the
// most credible, first-party source for these events). We fetch each fan zone's official
// page every run for two reasons: (1) a LIVENESS GUARD — we only emit events if the official
// page is currently reachable and still looks like a fan-zone page, so we never surface a
// zone that's been taken down; and (2) to read the reliably-rendered day headers.
//
// Why a small verified registry instead of pure scraping: the schedules are a JS carousel
// where only the active day fully renders (doors + per-match times), and the pages do NOT
// expose a street address. So per-match scraping would be fragile and location-less. Instead
// we keep a tiny registry of VERIFIED official facts (address, coordinates geocoded via the
// US Census / confirmed against the venue, official operating date range, doors time) and
// combine it with the live page. Dates come from the page's day headers when present, and
// fall back to the known official range — both accurate; locations are exact (not centroids).
//
// Scope note: only NYC fan zones still operating on/after today are worth emitting. Queens
// (Group Stage HQ, ended Jun 27) and the Bronx (ended Jun 14) are past. The Manhattan
// Telemundo Fan Village at Rockefeller Center is already covered by the NYC Tourism source,
// so it is intentionally omitted here to avoid duplicates.
const SOURCE_NAME = "NYNJ World Cup 26 Fan Zones"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

type FanZone = {
  key: string
  venueName: string
  address: string
  lat: number
  lng: number
  borough: string
  neighborhood: string
  // Official page fetched each run (also used as the event_url). Must stay reachable to emit.
  pageUrl: string
  // A keyword that must appear on the fetched page for it to count as "live" (guards against
  // redirects/garbage responses from the reader proxy).
  livenessKeyword: RegExp
  // Doors-open time in NY wall clock ("HH:MM"). Match kickoff times vary and are well known to
  // fans, so we anchor each day to doors-open rather than a specific match (per product intent:
  // don't over-index on exact match times).
  doorsTime: string
  // End-of-day operating time ("HH:MM"), used as each day's end_time.
  closeTime: string
  // Known official operating window (inclusive), NY dates "YYYY-MM-DD".
  rangeStart: string
  rangeEnd: string
  // When true, parse day headers off the live page and emit one event per operating DAY.
  // When false, emit a single ONGOING multi-day event spanning the operating window (used for
  // zones that run the whole tournament and publish no per-day dated page).
  perDay: boolean
}

const FAN_ZONES: FanZone[] = [
  {
    key: "staten-island",
    venueName: "Staten Island Fan Zone — SIUH Community Park",
    address: "75 Richmond Terrace, Staten Island, NY 10301",
    lat: 40.645575,
    lng: -74.076428,
    borough: "Staten Island",
    neighborhood: "St. George",
    pageUrl: "https://nynjfwc26.com/staten-island/",
    livenessKeyword: /staten island fan zone|schedule|watch party/i,
    doorsTime: "16:00",
    closeTime: "23:30",
    rangeStart: "2026-06-29",
    rangeEnd: "2026-07-02",
    perDay: true,
  },
  {
    key: "brooklyn",
    venueName: "Brooklyn Fan Zone — Brooklyn Bridge Park",
    address: "1 Water Street, Brooklyn, NY 11201",
    lat: 40.702995,
    lng: -73.994482,
    borough: "Brooklyn",
    neighborhood: "Brooklyn Bridge Park",
    // Brooklyn has no dedicated dated page; it's listed on the fan-events hub. We fetch the hub
    // as the liveness/credibility check and model the zone as one ongoing multi-day event.
    pageUrl: "https://nynjfwc26.com/fan-events/",
    livenessKeyword: /fan (zone|event)|world cup/i,
    doorsTime: "12:00",
    closeTime: "23:30",
    rangeStart: "2026-06-13",
    rangeEnd: "2026-07-19",
    perDay: false,
  },
]

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers: { "User-Agent": BROWSER_UA } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Extract distinct operating dates from a fan-zone page's day headers, e.g. "Tuesday, June 30".
// The weekday/month/day text renders reliably even though the per-match carousel does not.
function parseDayHeaders(md: string, todayNY: Date): string[] {
  const re =
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/gi
  const dates = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    const iso = monthDayToNyDate(m[1], Number(m[2]), todayNY)
    if (iso) dates.add(iso)
  }
  return [...dates].sort()
}

function baseEvent(z: FanZone): Omit<NormalizedEvent, "id" | "start_time" | "end_time" | "source_event_id"> {
  return {
    title:
      z.borough === "Brooklyn"
        ? "Brooklyn Fan Zone: World Cup 2026 Watch Parties"
        : "Staten Island Fan Zone: World Cup 2026 Watch Party",
    description:
      `Free, ticketed outdoor FIFA World Cup 2026™ watch party hosted by the NY/NJ Host ` +
      `Committee at ${z.venueName}. Matches are shown live on a big screen. A free ` +
      `general-admission ticket is required; see the official page for the day's fixtures and ` +
      `to reserve.`,
    source: SOURCE_NAME,
    event_url: z.pageUrl,
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
    image_url: null,
    // Exact, verified venue coordinates — not a centroid.
    approximate_location: false,
  }
}

export const nynjFanZonesSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startDay = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)

    const out: NormalizedEvent[] = []

    for (const z of FAN_ZONES) {
      // Liveness + credibility guard: only emit if the official page is reachable and looks right.
      const md = await fetchPage(z.pageUrl)
      if (!md || !z.livenessKeyword.test(md)) continue

      const rangeStartDate = new Date(`${z.rangeStart}T00:00:00`)
      const rangeEndDate = new Date(`${z.rangeEnd}T23:59:59`)

      if (z.perDay) {
        // Prefer dates read from the live page; clamp to the official window as a sanity check.
        // If the carousel stops rendering day headers, fall back to the whole known window.
        let dates = parseDayHeaders(md, todayNY).filter((d) => {
          const t = new Date(`${d}T12:00:00`).getTime()
          return t >= rangeStartDate.getTime() && t <= rangeEndDate.getTime()
        })
        if (dates.length === 0) {
          dates = []
          for (let t = rangeStartDate.getTime(); t <= rangeEndDate.getTime(); t += 86400000) {
            dates.push(new Date(t).toISOString().slice(0, 10))
          }
        }

        for (const date of dates) {
          const dayStart = new Date(`${date}T12:00:00`)
          if (dayStart < startDay || dayStart > endDay) continue // outside ingest horizon
          const startUtc = nyToUtcISO(date, z.doorsTime)
          const endUtc = nyToUtcISO(date, z.closeTime)
          if (!startUtc) continue
          out.push({
            ...baseEvent(z),
            id: deterministicId([SOURCE_NAME, z.key, date]),
            source_event_id: `${z.key}:${date}`,
            start_time: startUtc,
            end_time: endUtc,
          })
        }
      } else {
        // Ongoing multi-day zone: one event spanning the official window, shown while it runs.
        if (rangeEndDate < startDay) continue // window already over
        if (rangeStartDate > endDay) continue // window starts beyond the horizon
        const startUtc = nyToUtcISO(z.rangeStart, z.doorsTime)
        const endUtc = nyToUtcISO(z.rangeEnd, z.closeTime)
        if (!startUtc || !endUtc) continue
        out.push({
          ...baseEvent(z),
          // Stable id keyed to the window start, so daily re-ingests refresh in place.
          id: deterministicId([SOURCE_NAME, z.key, z.rangeStart]),
          source_event_id: `${z.key}:${z.rangeStart}..${z.rangeEnd}`,
          start_time: startUtc,
          end_time: endUtc,
        })
      }
    }

    return out
  },
}
