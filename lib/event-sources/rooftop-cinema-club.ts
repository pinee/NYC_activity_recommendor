import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"

// Rooftop Cinema Club's NYC location (Midtown) lists its upcoming screenings server-side at
// /us/new-york/midtown. Each screening links to a detail page exposing a schema.org
// ScreeningEvent with the film name and start time. NOTE: that JSON-LD stamps the time with
// a "+00:00" offset, but the value is actually the local NY wall-clock time (it matches the
// on-page showtimes), so we reinterpret it as America/New_York rather than UTC.
const SOURCE_NAME = "Rooftop Cinema Club"
const VENUE_PAGE = "https://rooftopcinemaclub.com/us/new-york/midtown"
const ORIGIN = "https://rooftopcinemaclub.com"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Rooftop Cinema Club Midtown: 60 West 37th Street rooftop. Single fixed venue (exact).
const VENUE = {
  lat: 40.7512,
  lng: -73.9856,
  name: "Rooftop Cinema Club Midtown",
  address: "60 West 37th Street, New York, NY 10018",
}

function clean(s: string | null | undefined): string {
  if (!s) return ""
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Read the ScreeningEvent JSON-LD from a screening detail page.
async function fetchScreening(slug: string): Promise<{ name: string; date: string; time: string } | null> {
  try {
    const res = await fetch(`${ORIGIN}${slug}`, {
      headers: { Accept: "text/html,*/*", "User-Agent": BROWSER_UA, Referer: VENUE_PAGE },
    })
    if (!res.ok) return null
    const html = await res.text()
    const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
    for (const b of blocks) {
      try {
        const parsed = JSON.parse(b)
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        for (const x of arr) {
          if (/screening|event/i.test(String(x["@type"] || "")) && x.startDate) {
            const m = String(x.startDate).match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
            if (m) return { name: clean(x.name) || "Screening", date: m[1], time: m[2] }
          }
        }
      } catch {
        // ignore malformed block
      }
    }
  } catch {
    // network error — skip this screening
  }
  return null
}

export const rooftopCinemaClubSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }: { horizonDays: number }) {
    let html: string
    try {
      const res = await fetch(VENUE_PAGE, { headers: { Accept: "text/html,*/*", "User-Agent": BROWSER_UA } })
      if (!res.ok) {
        console.log(`[v0] ${SOURCE_NAME}: venue page returned ${res.status}`)
        return []
      }
      html = await res.text()
    } catch (err) {
      console.log(`[v0] ${SOURCE_NAME}: fetch failed - ${(err as Error).message}`)
      return []
    }

    const slugs = [
      ...new Set(
        [...html.matchAll(/href="(\/us\/new-york\/midtown\/screenings\/[a-z0-9-]+)"/g)].map((m) => m[1]),
      ),
    ]
      // Private hires aren't public events.
      .filter((s) => !/\/private-screening-/.test(s))

    const now = Date.now()
    const horizonEnd = now + horizonDays * 86400_000
    const out: NormalizedEvent[] = []

    for (const slug of slugs) {
      const info = await fetchScreening(slug)
      if (!info) continue
      // Reinterpret the JSON-LD wall-clock time as New York local time.
      const startUtc = nyToUtcISO(info.date, info.time)
      if (!startUtc) continue
      const startMs = new Date(startUtc).getTime()
      if (startMs < now - 6 * 3600_000 || startMs > horizonEnd) continue

      const isSports = /fifa|world cup|semi-final|final|match|game/i.test(info.name)
      const eventUrl = `${ORIGIN}${slug}`

      out.push({
        id: deterministicId([SOURCE_NAME, slug, startUtc]),
        title: isSports ? info.name : `${info.name} (Rooftop Cinema)`,
        description: isSports
          ? `${info.name} on the big screen at Rooftop Cinema Club Midtown`
          : `Open-air rooftop screening of ${info.name} at Rooftop Cinema Club Midtown`,
        source: SOURCE_NAME,
        source_event_id: slug,
        event_url: eventUrl,
        venue_name: VENUE.name,
        address: VENUE.address,
        latitude: VENUE.lat,
        longitude: VENUE.lng,
        borough: "Manhattan",
        neighborhood: "Midtown",
        category: isSports ? "Sports & games" : "Film & cinema",
        tags: ["rooftop cinema club", "outdoor film", "rooftop"],
        organizer: "Rooftop Cinema Club",
        start_time: startUtc,
        end_time: null,
        // Ticketed, but the listing carries no machine-readable price.
        price: null,
        currency: null,
        image_url: null,
        approximate_location: false,
      })
    }

    console.log(`[v0] ${SOURCE_NAME}: parsed ${out.length} screenings`)
    return out
  },
}
