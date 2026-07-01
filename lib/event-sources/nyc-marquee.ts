import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday, nyToUtcISO } from "./util"

// Curated NYC "marquee" events — the big, citywide happenings (Macy's 4th of July
// Fireworks, the NYE ball drop, the Village Halloween Parade, etc.) that don't live in
// any of the venue/park feeds we scrape. There is no clean public API for these, so this
// is a small, HAND-MAINTAINED list. Each entry has an explicit calendar date; the source
// only emits an entry when its date falls inside the requested ingest horizon, so stale
// past events naturally drop off and future ones appear as they come into range.
//
// To add/refresh an event: append an entry below with an accurate date, time, and public
// viewing location. Keep details conservative (favor official public info) since these are
// presented to users as authoritative.

const SOURCE_NAME = "NYC Marquee Events"

type MarqueeEntry = {
  // Stable key so re-ingesting the same event de-dupes via deterministicId.
  key: string
  title: string
  description: string
  // NYC wall-clock date (YYYY-MM-DD) and 24h start/optional end time.
  date: string
  startTime: string // "HH:MM"
  endTime?: string // "HH:MM"
  venueName: string
  address: string
  borough: string
  neighborhood: string
  latitude: number
  longitude: number
  eventUrl: string
  organizer: string
  price: string // "Free" for public viewing
  // True when the coordinates are a representative public viewing spot rather than a
  // single precise venue (these events span miles of waterfront / multiple boroughs).
  approximateLocation: boolean
  // Category MUST contain a keyword from an INTEREST in lib/types.ts or the plan's
  // pre-filter will drop it. "Festivals & fireworks" matches that interest's keywords.
  category: string
  tags: string[]
}

// Keep this list current each season. Dates are specific years on purpose.
const ENTRIES: MarqueeEntry[] = [
  {
    key: "macys-4th-of-july-fireworks-2026",
    title: "Macy's 4th of July Fireworks",
    description:
      "The nation's largest Independence Day fireworks display lights up the New York sky. " +
      "For 2026 the barges are staged along the lower East River (near the Seaport) with shells " +
      "also over the lower Hudson and around the Brooklyn Bridge. Free non-ticketed public viewing " +
      "is available along the FDR Drive in Manhattan; arrive a few hours early as entry points fill " +
      "up. Fireworks typically begin around 9:25 PM and run about 25 minutes.",
    date: "2026-07-04",
    startTime: "21:25",
    endTime: "21:55",
    venueName: "Lower East River / FDR Drive public viewing",
    address: "FDR Drive at the East River, Lower Manhattan, New York, NY",
    borough: "Manhattan",
    neighborhood: "Lower Manhattan",
    latitude: 40.7064,
    longitude: -74.0027,
    eventUrl: "https://www.macys.com/social/fireworks/",
    organizer: "Macy's",
    price: "Free",
    approximateLocation: true,
    category: "Festivals & fireworks",
    tags: ["fireworks", "fourth of july", "independence day", "festival", "outdoor"],
  },
]

export const nycMarqueeSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const startMs = nyMidnightToday().getTime()
    const endMs = startMs + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    for (const e of ENTRIES) {
      const startUtc = nyToUtcISO(e.date, e.startTime)
      if (!startUtc) continue
      // Only emit events whose date is within [today, today + horizon].
      const t = new Date(startUtc).getTime()
      if (t < startMs || t > endMs) continue

      const endUtc = e.endTime ? nyToUtcISO(e.date, e.endTime) : null

      out.push({
        id: deterministicId([SOURCE_NAME, e.key]),
        title: e.title,
        description: e.description,
        source: SOURCE_NAME,
        source_event_id: e.key,
        event_url: e.eventUrl,
        venue_name: e.venueName,
        address: e.address,
        latitude: e.latitude,
        longitude: e.longitude,
        borough: e.borough,
        neighborhood: e.neighborhood,
        category: e.category,
        tags: e.tags,
        organizer: e.organizer,
        start_time: startUtc,
        end_time: endUtc,
        price: e.price,
        currency: "USD",
        image_url: null,
        approximate_location: e.approximateLocation,
      })
    }
    return out
  },
}
