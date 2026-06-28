import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// Brooklyn Bridge Park's events calendar. The public /events/ page is server-rendered, but
// it also exposes a clean internal JSON endpoint (the same one its "Calendar" tab calls):
//   /wp-admin/admin-ajax.php?action=get_calendar_events&start=YYYY-MM-DD&end=YYYY-MM-DD
// which returns an array of well-structured events (title, url, start/end, location,
// category, description). We hit that directly for the whole horizon in one request.
const SOURCE_NAME = "Brooklyn Bridge Park"
const AJAX_URL = "https://brooklynbridgepark.org/wp-admin/admin-ajax.php"
const EVENTS_PAGE = "https://brooklynbridgepark.org/events/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

type BBPEvent = {
  id?: number
  title?: string
  url?: string
  start?: string // e.g. "2026-06-28T2:00 pm"
  end?: string
  eventDate?: string
  eventTime?: string
  location?: string
  category?: string
  series?: string
  description?: string
}

// Decode the handful of HTML entities the feed emits, strip tags, collapse whitespace.
function clean(s: string | null | undefined): string {
  if (!s) return ""
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8230;/g, "...")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Parse the feed's "YYYY-MM-DDTh:mm am/pm" timestamp into a NY date + 24h time, then
// convert to a UTC ISO string. Returns null when the string is malformed.
function bbpToUtcISO(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(raw.trim())
  if (!m) {
    // Some entries may be a bare date with no time — treat as midnight.
    const dm = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim())
    return dm ? nyToUtcISO(dm[1], "00:00") : null
  }
  const date = m[1]
  let hour = Number(m[2])
  const min = Number(m[3])
  const ap = m[4].toLowerCase()
  if (ap === "pm" && hour < 12) hour += 12
  if (ap === "am" && hour === 12) hour = 0
  return nyToUtcISO(date, `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`)
}

// Precise coordinates for Brooklyn Bridge Park's named sub-locations. The feed gives a spot
// name (e.g. "Pier 2", "Fulton Ferry Landing") rather than an address, but these are fixed,
// well-known points inside the park, so we map them directly — making travel times exact.
const PARK_CENTER = { lat: 40.6976, lng: -73.9979 }
const LOCATION_COORDS: Array<{ match: string; lat: number; lng: number }> = [
  { match: "pier 1 salt marsh", lat: 40.7001, lng: -73.9958 },
  { match: "pier 1", lat: 40.7008, lng: -73.9962 },
  { match: "pier 2 turf", lat: 40.6987, lng: -73.9994 },
  { match: "pier 2", lat: 40.6987, lng: -73.9994 },
  { match: "pier 3 central lawn", lat: 40.6975, lng: -74.0009 },
  { match: "pier 3", lat: 40.6975, lng: -74.0009 },
  { match: "pier 4 beach", lat: 40.6959, lng: -74.0013 },
  { match: "pier 5", lat: 40.6938, lng: -74.0019 },
  { match: "pier 6", lat: 40.6928, lng: -74.003 },
  { match: "environmental education center", lat: 40.7, lng: -73.997 },
  { match: "visitor center at the boathouse", lat: 40.701, lng: -73.996 },
  { match: "fulton ferry landing", lat: 40.7033, lng: -73.9935 },
  { match: "granite prospect", lat: 40.7006, lng: -73.9968 },
  { match: "harbor view lawn", lat: 40.6995, lng: -73.9985 },
  { match: "liberty lawn", lat: 40.692, lng: -74.0035 },
  { match: "empire fulton ferry", lat: 40.703, lng: -73.995 },
  { match: "main street", lat: 40.7036, lng: -73.9925 },
  { match: "jane's carousel", lat: 40.7027, lng: -73.9935 },
  { match: "squibb park", lat: 40.6986, lng: -73.9959 },
]

// Resolve a location name to coordinates. Returns the matched point (exact) or the park
// center as a fallback (approximate) so events without a recognized spot still map roughly.
function resolveLocation(location: string | null): { lat: number; lng: number; exact: boolean } {
  const hay = (location || "").toLowerCase()
  for (const l of LOCATION_COORDS) {
    if (hay.includes(l.match)) return { lat: l.lat, lng: l.lng, exact: true }
  }
  return { ...PARK_CENTER, exact: false }
}

// Whole-word keyword match (avoids "ride" matching inside "pride", etc.).
function hasWord(hay: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay)
}

// Map the feed's category + title to one of our interest categories. The feed's own
// category is the strongest signal; we fall back to title keywords, then to a sensible
// park default. Returns a string that the DB pre-filter can substring-match to an interest.
function inferCategory(bbpCategory: string, title: string): string {
  const cat = bbpCategory.toLowerCase()
  if (cat.includes("fitness")) return "Running & fitness"
  if (cat.includes("volunteer")) return "Volunteering"
  if (cat.includes("environmental")) return "Hiking & parks"
  if (cat.includes("tour")) return "Hiking & parks"
  if (cat.includes("arts") || cat.includes("culture")) {
    // Bargemusic etc. are concerts; route those to Live music, otherwise Arts & Culture.
    if (/music|concert|jazz|band/i.test(title)) return "Live music"
    return "Arts & Culture"
  }
  // No usable category — infer from the title against our interest keyword map.
  const hay = title.toLowerCase()
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  // Everything here happens in the park, so default to Hiking & parks.
  return "Hiking & parks"
}

function buildEvents(rows: BBPEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const now = Date.now()
  for (const r of rows) {
    const title = clean(r.title)
    const url = r.url || null
    if (!title || !url) continue
    const startUtc = bbpToUtcISO(r.start)
    if (!startUtc) continue
    const endUtc = bbpToUtcISO(r.end)
    // Drop events that have already ended (or already started, if no end time).
    const effectiveEnd = endUtc ? new Date(endUtc).getTime() : new Date(startUtc).getTime()
    if (effectiveEnd < now) continue

    const location = clean(r.location) || null
    const bbpCategory = clean(r.category)
    const category = inferCategory(bbpCategory, title)
    const { lat, lng, exact } = resolveLocation(location)
    const description = clean(r.description) || null

    const tags = ["brooklyn bridge park"]
    if (bbpCategory) tags.push(bbpCategory.toLowerCase())
    if (r.series) tags.push(clean(r.series).toLowerCase())

    out.push({
      id: deterministicId([SOURCE_NAME, url]),
      title,
      description,
      source: SOURCE_NAME,
      source_event_id: r.id ? String(r.id) : url,
      event_url: url,
      venue_name: location ? `${location}, Brooklyn Bridge Park` : "Brooklyn Bridge Park",
      address: location ? `${location}, Brooklyn Bridge Park, Brooklyn, NY` : "Brooklyn Bridge Park, Brooklyn, NY",
      latitude: lat,
      longitude: lng,
      borough: "Brooklyn",
      neighborhood: "Brooklyn Bridge Park",
      category,
      tags,
      organizer: "Brooklyn Bridge Park",
      start_time: startUtc,
      end_time: endUtc,
      // Park programming is free unless the event says otherwise; the feed has no price.
      price: "Free",
      currency: "USD",
      image_url: null,
      // Exact when we matched a specific named spot; approximate when we fell back to the
      // park center for an unrecognized location.
      approximate_location: !exact,
    })
  }
  return out
}

export const brooklynBridgeParkSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }: { horizonDays: number }) {
    const nowNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    const end = new Date(nowNY)
    end.setDate(end.getDate() + horizonDays)
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    const url = `${AJAX_URL}?action=get_calendar_events&start=${fmt(nowNY)}&end=${fmt(end)}`

    const res = await fetch(url, {
      headers: {
        Accept: "application/json, */*; q=0.01",
        "User-Agent": BROWSER_UA,
        "X-Requested-With": "XMLHttpRequest",
        Referer: EVENTS_PAGE,
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const rows: BBPEvent[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
    return buildEvents(rows)
  },
}
