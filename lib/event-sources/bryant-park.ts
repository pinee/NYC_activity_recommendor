import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO, parseClockTo24h } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Bryant Park renders its calendar via a server-side "week" fragment at /calendar/week.
// Each card embeds the event date in its detail URL (/calendar/event/SLUG/YYYY-MM-DD) and
// the time in a "cardFlag" label. The whole park is one fixed Midtown block, so every
// event shares the same precise coordinates (exact, not approximate).
const SOURCE_NAME = "Bryant Park"
const WEEK_URL = "https://bryantpark.org/calendar/week"
const CALENDAR_PAGE = "https://bryantpark.org/calendar"
const BASE = "https://bryantpark.org"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Bryant Park, Manhattan (42nd St & 6th Ave). Single, well-defined footprint.
const PARK = { lat: 40.7536, lng: -73.9832 }

function clean(s: string | null | undefined): string {
  if (!s) return ""
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#039;|&#39;|&#x27;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map the activity label + title to one of our interest categories (must be a value the
// DB pre-filter can substring-match to an interest, so we return real interest names).
function inferCategory(activity: string, title: string): string {
  const hay = `${activity} ${title}`.toLowerCase()
  if (/yoga|tai chi|meditation|pilates|wellness/.test(hay)) return "Yoga & wellness"
  if (/martial art|fitness|bootcamp|workout/.test(hay)) return "Running & fitness"
  if (/juggl|chess|game|backgammon|ping pong|petanque|board game|pickleball/.test(hay)) return "Sports & games"
  if (/piano|music|jazz|band|concert|sing/.test(hay)) return "Live music"
  if (/reading|book|poetry|author|literary/.test(hay)) return "Books & readings"
  if (/art|paint|draw|craft|sketch/.test(hay)) return "Art & galleries"
  if (/film|movie|cinema|screening/.test(hay)) return "Film & cinema"
  if (/tour|garden|explorer|birding|nature/.test(hay)) return "Hiking & parks"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  // Everything happens in the park; default to a park category.
  return "Hiking & parks"
}

function buildEvents(html: string): NormalizedEvent[] {
  const cards = html.split(/<li class="card calendarEventCard">/).slice(1)
  const out: NormalizedEvent[] = []
  const now = Date.now()
  const seen = new Set<string>()

  for (const card of cards) {
    const titleMatch = card.match(
      /cardTitle">\s*<a href="(\/calendar\/event\/[a-z0-9-]+\/(\d{4}-\d{2}-\d{2}))">([\s\S]*?)<\/a>/,
    )
    if (!titleMatch) continue
    const path = titleMatch[1]
    const ymd = titleMatch[2]
    const title = clean(titleMatch[3])
    if (!title) continue

    const flag = clean((card.match(/cardFlag">([\s\S]*?)<\/div>/) || [])[1])
    const activity = clean((card.match(/smallActivityName">([\s\S]*?)<\/div>/) || [])[1])

    // Pull a clock time out of the flag ("...at 2:30pm"); default to late morning for
    // all-day amenities (e.g. "Bryant Park Shop") so they still place on a day plan.
    const time = parseClockTo24h(flag) || "11:00"
    const startUtc = nyToUtcISO(ymd, time)
    if (!startUtc) continue
    if (new Date(startUtc).getTime() < now - 12 * 3600_000) continue

    // De-dupe recurring amenities that repeat across the week at the same slot.
    const key = `${title}|${startUtc}`
    if (seen.has(key)) continue
    seen.add(key)

    const category = inferCategory(activity, title)
    const url = `${BASE}${path}`
    const tags = ["bryant park"]
    if (activity) tags.push(activity.toLowerCase())

    out.push({
      id: deterministicId([SOURCE_NAME, path]),
      title,
      description: activity && activity !== title ? `${activity} at Bryant Park` : null,
      source: SOURCE_NAME,
      source_event_id: path,
      event_url: url,
      venue_name: "Bryant Park",
      address: "Bryant Park, New York, NY 10018",
      latitude: PARK.lat,
      longitude: PARK.lng,
      borough: "Manhattan",
      neighborhood: "Midtown",
      category,
      tags,
      organizer: "Bryant Park Corporation",
      start_time: startUtc,
      end_time: null,
      price: "Free",
      currency: "USD",
      image_url: null,
      approximate_location: false,
    })
  }
  return out
}

export const bryantParkSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents() {
    const res = await fetch(WEEK_URL, {
      headers: {
        Accept: "text/html,*/*",
        "User-Agent": BROWSER_UA,
        "X-Requested-With": "XMLHttpRequest",
        Referer: CALENDAR_PAGE,
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    return buildEvents(html)
  },
}
