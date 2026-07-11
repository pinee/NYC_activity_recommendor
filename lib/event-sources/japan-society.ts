import type { EventSource, NormalizedEvent } from "./types"
import {
  deterministicId,
  nyMidnightToday,
  nyToUtcISO,
  parseClockTo24h,
  monthDayToNyDate,
  inferCategoryFromText,
} from "./util"

// Japan Society (japansociety.org) — Midtown East cultural institution: performing arts
// (dance, music, theater), film screenings, talks, and exhibitions. Runs WordPress and
// exposes a key-less REST feed at /wp-json/wp/v2/events.
//
// Unlike Tribe, this feed has NO structured event date field — the WP `date` is the post's
// publish date, and the page JSON-LD startDate is a bogus 1970 placeholder. The real dates
// live in prose inside the content/SEO description, e.g. "July 22 at 5:30 PM - SOLD OUT /
// July 23 at 5:30 PM / August 13 at 5:30 PM". Per the source scope, we parse every such
// occurrence and keep the FIRST upcoming one as the event's start time.
//
// Single venue (333 E 47th St), so we supply the building coordinates as an exact location.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const API = "https://japansociety.org/wp-json/wp/v2/events?per_page=100&_embed"
const JS_LAT = 40.7519
const JS_LNG = -73.9682
const JS_ADDRESS = "333 E 47th St, New York, NY 10017"

type WpEvent = {
  id?: number
  link?: string
  title?: { rendered?: string }
  content?: { rendered?: string }
  excerpt?: { rendered?: string }
  yoast_head_json?: { og_description?: string; og_image?: { url?: string }[] }
  _embedded?: {
    "wp:featuredmedia"?: { source_url?: string }[]
    "wp:term"?: { name?: string }[][]
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim()
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
}

// Parse the FIRST upcoming "Month Day [at] H[:MM] am/pm" occurrence in a blob of prose.
// Returns the NY date (YYYY-MM-DD) + 24h time, or null when nothing upcoming is found.
function firstUpcomingDate(text: string, todayNY: Date): { date: string; time: string } | null {
  const re =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*(?:at|@|,)?\s*(\d{1,2}(?::\d{2})?\s*[APap][Mm]))?/g
  const todayMidnight = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate()).getTime()

  const found: { date: string; time: string; ms: number }[] = []
  for (const m of text.matchAll(re)) {
    const date = monthDayToNyDate(m[1], Number(m[2]), todayNY)
    if (!date) continue
    // Normalize hour-only clocks ("7 PM" -> "7:00 PM") so the shared HH:MM parser accepts them.
    const rawTime = (m[3] || "").replace(/^(\d{1,2})\s*([APap][Mm])$/, "$1:00 $2")
    const time = parseClockTo24h(rawTime) || "00:00"
    const [y, mo, d] = date.split("-").map(Number)
    const ms = new Date(y, mo - 1, d).getTime()
    found.push({ date, time, ms })
  }
  if (found.length === 0) return null

  // Prefer the earliest occurrence that is today or later; otherwise there's nothing upcoming.
  found.sort((a, b) => a.ms - b.ms || (a.time < b.time ? -1 : 1))
  const upcoming = found.find((f) => f.ms >= todayMidnight)
  if (!upcoming) return null
  return { date: upcoming.date, time: upcoming.time }
}

export const japanSocietySource: EventSource = {
  name: "Japan Society",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const todayNY = nyMidnightToday()
    const startWindow = todayNY.getTime()
    const endWindow = startWindow + horizonDays * 86400000

    let events: WpEvent[]
    try {
      const res = await fetch(API, { headers: { Accept: "application/json", "User-Agent": BROWSER_UA } })
      if (!res.ok) throw new Error(`Japan Society feed returned HTTP ${res.status}`)
      events = (await res.json()) as WpEvent[]
    } catch {
      return []
    }

    const out: NormalizedEvent[] = []
    for (const e of events || []) {
      const title = e.title?.rendered ? decodeEntities(e.title.rendered) : ""
      const url = e.link?.trim()
      if (!title || !url) continue

      // Dates only appear in prose; prefer the richer article body, fall back to the SEO blurb.
      const body = stripHtml(e.content?.rendered || "")
      const blurb = e.yoast_head_json?.og_description || ""
      const dateInfo = firstUpcomingDate(`${blurb} ${body}`, todayNY)
      if (!dateInfo) continue

      const startISO = nyToUtcISO(dateInfo.date, dateInfo.time)
      if (!startISO) continue
      const startMs = new Date(startISO).getTime()
      if (startMs < startWindow || startMs > endWindow) continue

      const description = stripHtml(e.excerpt?.rendered || "") || body.slice(0, 500) || null
      const image =
        e._embedded?.["wp:featuredmedia"]?.[0]?.source_url ||
        e.yoast_head_json?.og_image?.[0]?.url ||
        null
      const terms = (e._embedded?.["wp:term"] || []).flat().map((t) => t?.name && decodeEntities(t.name)).filter(Boolean) as string[]

      out.push({
        id: deterministicId(["Japan Society", String(e.id || url)]),
        title,
        description,
        source: "Japan Society",
        source_event_id: e.id !== undefined ? String(e.id) : null,
        event_url: url,
        venue_name: "Japan Society",
        address: JS_ADDRESS,
        latitude: JS_LAT,
        longitude: JS_LNG,
        borough: "Manhattan",
        neighborhood: "Midtown East",
        // Infer topic from the title/description (dance, film, talk, etc.); fall back to
        // Museums since Japan Society is a cultural institution added under that interest.
        category: inferCategoryFromText(title, description) || "Museums",
        tags: [...new Set(["Japan Society", ...terms])],
        organizer: "Japan Society",
        start_time: startISO,
        end_time: null,
        price: null,
        currency: "USD",
        image_url: image,
        // Single, known venue with exact building coordinates.
        approximate_location: false,
      })
    }

    return out
  },
}
