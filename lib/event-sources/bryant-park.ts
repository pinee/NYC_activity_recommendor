import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO, parseClockTo24h } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Bryant Park renders its calendar as server-side fragments. We use the MONTH view
// (/calendar/month/YYYY/MM) rather than the week fragment (/calendar/week), because the
// week fragment only ever returns the current 7 days and ignores any date param — so it
// could never cover our full ~14-day horizon. The month view exposes every event as an
// anchor: <a href="/calendar/event/SLUG/YYYY-MM-DD" class="calendarEvent"> TITLE
// <span>7:00pm-8:30pm</span></a>. We fetch each month the horizon touches (usually one or
// two) and parse those anchors. The whole park is one fixed Midtown block, so every event
// shares the same precise coordinates (exact, not approximate).
const SOURCE_NAME = "Bryant Park"
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

// List the "YYYY/MM" month paths that the horizon window [today, today+horizonDays] spans.
// Almost always one or two months; we walk month-by-month so a horizon crossing a month
// boundary (e.g. June 30 -> July 14) still fetches both.
function monthsInHorizon(todayNY: Date, horizonDays: number): string[] {
  const end = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate() + horizonDays)
  const months: string[] = []
  const cursor = new Date(todayNY.getFullYear(), todayNY.getMonth(), 1)
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}/${String(cursor.getMonth() + 1).padStart(2, "0")}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

function buildEvents(
  html: string,
  out: NormalizedEvent[],
  seen: Set<string>,
  startMs: number,
  endMs: number,
): void {
  // Each event is an anchor: <a href="/calendar/event/SLUG/YYYY-MM-DD" class="calendarEvent ">
  //   Title<span>7:00pm-8:30pm</span></a>
  const re =
    /<a href="(\/calendar\/event\/[a-z0-9-]+\/(\d{4}-\d{2}-\d{2}))"\s+class="calendarEvent\s*">([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const path = m[1]
    const ymd = m[2]
    const inner = m[3]

    // Split the inner content into the title text and the "<span>start-end</span>" time.
    const span = (inner.match(/<span>([\s\S]*?)<\/span>/) || [])[1] || ""
    const title = clean(inner.replace(/<span>[\s\S]*?<\/span>/, ""))
    if (!title) continue

    // Time span is "7:00pm-8:30pm"; take the start, and the end when present.
    const [startRaw, endRaw] = span.split("-")
    const time = parseClockTo24h(startRaw || "") || "11:00"
    const startUtc = nyToUtcISO(ymd, time)
    if (!startUtc) continue
    const t = new Date(startUtc).getTime()
    if (t < startMs || t > endMs) continue

    const endTime = endRaw ? parseClockTo24h(endRaw) : null
    const endUtc = endTime ? nyToUtcISO(ymd, endTime) : null

    // De-dupe recurring amenities that repeat at the same slot (and across overlapping
    // month fetches).
    const key = `${title}|${startUtc}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      id: deterministicId([SOURCE_NAME, path]),
      title,
      description: null,
      source: SOURCE_NAME,
      source_event_id: path,
      event_url: `${BASE}${path}`,
      venue_name: "Bryant Park",
      address: "Bryant Park, New York, NY 10018",
      latitude: PARK.lat,
      longitude: PARK.lng,
      borough: "Manhattan",
      neighborhood: "Midtown",
      category: inferCategory("", title),
      tags: ["bryant park"],
      organizer: "Bryant Park Corporation",
      start_time: startUtc,
      end_time: endUtc,
      price: "Free",
      currency: "USD",
      image_url: null,
      approximate_location: false,
    })
  }
}

export const bryantParkSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const startMs = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate()).getTime()
    const endMs = startMs + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()
    for (const month of monthsInHorizon(todayNY, horizonDays)) {
      const res = await fetch(`${BASE}/calendar/month/${month}`, {
        headers: {
          Accept: "text/html,*/*",
          "User-Agent": BROWSER_UA,
          "X-Requested-With": "XMLHttpRequest",
          Referer: CALENDAR_PAGE,
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} for month ${month}`)
      buildEvents(await res.text(), out, seen, startMs, endMs)
    }
    return out
  },
}
