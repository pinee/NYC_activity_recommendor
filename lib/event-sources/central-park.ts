import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// The Central Park Conservancy site is client-rendered, but its activity list is backed by
// a clean JSON endpoint (the same one the /activities page calls):
//   /activities.json?filters={"category":["events"],...}&page=N&elementsPerPage=M
// Each activity carries a title, url, summary, tags, and one or more dated eventInstances
// (with a duration). Central Park is large and the feed gives no specific in-park spot, so
// we place events at the park centroid and flag them approximate.
const SOURCE_NAME = "Central Park"
const BASE = "https://www.centralparknyc.org"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Central Park centroid (around the Great Lawn). Approximate by design — the park spans
// ~1.3 sq mi, so this is a rough placement, not an exact venue.
const PARK_CENTER = { lat: 40.7812, lng: -73.9665 }

type CPInstance = { instanceDate?: string; instanceDuration?: number; isSoldOut?: boolean }
type CPActivity = {
  id?: number
  title?: string
  url?: string
  summary?: string
  startDate?: string
  eventInstances?: CPInstance[]
  tags?: string[]
}

function clean(s: string | null | undefined): string {
  if (!s) return ""
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;|&#039;|&#39;/g, "'")
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

// Map title + summary (genres) + tags to an interest category.
function inferCategory(title: string, summary: string, tags: string[]): string {
  const hay = `${title} ${summary} ${tags.join(" ")}`.toLowerCase()
  if (/jazz|blues|soul|gospel|hip-hop|latin|band|concert|music|orchestra|sing/.test(hay)) return "Live music"
  if (/dance|ballet|salsa|tango/.test(hay)) return "Dance"
  if (/yoga|wellness|meditation|tai chi|pilates/.test(hay)) return "Yoga & wellness"
  if (/run|marathon|fitness|workout/.test(hay)) return "Running & fitness"
  if (/tour|birding|nature|walk|garden|wildlife/.test(hay)) return "Hiking & parks"
  if (/film|movie|cinema|screening/.test(hay)) return "Film & cinema"
  if (/art|paint|craft|sketch|exhibit/.test(hay)) return "Art & galleries"
  if (/talk|lecture|reading|book|author|poetry/.test(hay)) return "Books & readings"
  if (/volunteer|cleanup|stewardship/.test(hay)) return "Volunteering"
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Hiking & parks"
}

function buildEvents(rows: CPActivity[], horizonDays: number): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const now = Date.now()
  const horizonEnd = now + horizonDays * 86400_000
  const seen = new Set<string>()

  for (const r of rows) {
    const title = clean(r.title)
    const url = r.url || null
    if (!title || !url) continue
    const summary = clean(r.summary)
    const tags = Array.isArray(r.tags) ? r.tags : []
    const category = inferCategory(title, summary, tags)

    // Expand each dated instance; fall back to the activity's top-level startDate.
    const instances: CPInstance[] =
      r.eventInstances && r.eventInstances.length > 0
        ? r.eventInstances
        : r.startDate
          ? [{ instanceDate: r.startDate, instanceDuration: 0 }]
          : []

    for (const inst of instances) {
      if (!inst.instanceDate) continue
      // instanceDate already carries the NY offset (e.g. "...-04:00"), so this is exact UTC.
      const startMs = new Date(inst.instanceDate).getTime()
      if (Number.isNaN(startMs)) continue
      if (startMs < now - 12 * 3600_000 || startMs > horizonEnd) continue

      const startUtc = new Date(startMs).toISOString()
      const durMin = typeof inst.instanceDuration === "number" ? inst.instanceDuration : 0
      const endUtc = durMin > 0 ? new Date(startMs + durMin * 60_000).toISOString() : null

      const key = `${title}|${startUtc}`
      if (seen.has(key)) continue
      seen.add(key)

      out.push({
        id: deterministicId([SOURCE_NAME, url, startUtc]),
        title,
        description: summary || null,
        source: SOURCE_NAME,
        source_event_id: `${url}#${startUtc}`,
        event_url: url,
        venue_name: "Central Park",
        address: "Central Park, New York, NY",
        latitude: PARK_CENTER.lat,
        longitude: PARK_CENTER.lng,
        borough: "Manhattan",
        neighborhood: "Central Park",
        category,
        tags: ["central park", ...tags.map((t) => t.toLowerCase())],
        organizer: "Central Park Conservancy",
        start_time: startUtc,
        end_time: endUtc,
        price: null,
        currency: null,
        image_url: null,
        // Park centroid, not a specific in-park venue.
        approximate_location: true,
      })
    }
  }
  return out
}

export const centralParkSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }: { horizonDays: number }) {
    const filters = encodeURIComponent(JSON.stringify({ category: ["events"], interest: [], dateRange: {} }))
    const all: CPActivity[] = []
    // Paginate defensively; the feed is small (one or two pages) but this future-proofs it.
    for (let page = 1; page <= 5; page++) {
      const url = `${BASE}/activities.json?q=&filters=${filters}&page=${page}&elementsPerPage=24`
      const res = await fetch(url, {
        headers: {
          Accept: "application/json, */*; q=0.01",
          "User-Agent": BROWSER_UA,
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${BASE}/activities?category=events`,
        },
      })
      if (!res.ok) {
        if (page === 1) throw new Error(`HTTP ${res.status}`)
        break
      }
      const data = await res.json()
      const rows: CPActivity[] = Array.isArray(data?.data) ? data.data : []
      all.push(...rows)
      const totalPages = data?.meta?.pagination?.total_pages ?? 1
      if (page >= totalPages) break
    }
    return buildEvents(all, horizonDays)
  },
}
