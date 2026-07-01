import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday, inferCategoryFromText } from "./util"

// Generic adapter for any WordPress site running "The Events Calendar" (Tribe) plugin,
// which exposes a free, key-less JSON REST API at /wp-json/tribe/events/v1/events.
// Many NYC cultural orgs use this exact plugin, so a new site becomes a one-line config
// in lib/event-sources/index.ts rather than new code.

export type TribeSourceConfig = {
  // Human-readable source name, written to events.source.
  name: string
  // Site origin, e.g. "https://cityparksfoundation.org" (no trailing slash).
  baseUrl: string
  enabled?: boolean
  // Optional Tribe category slug to filter the feed (e.g. "summerstage").
  categorySlug?: string
  // Optional organizer label written to events.organizer.
  organizer?: string
  // Optional headline category override. Useful when the site's own category text
  // (e.g. "SummerStage") doesn't contain words our interest pre-filter looks for.
  // The site's real categories are still preserved in `tags`.
  categoryOverride?: string
  // When true, infer each event's category from its title/description (via
  // inferCategoryFromText) instead of trusting the site's categories. Useful for sites
  // whose categories describe format, not topic (e.g. Flatiron NoMad tags everything
  // "Culture"/"Entertainment", which matches no interest). Falls back to categoryOverride,
  // then the site category, when inference is inconclusive. Site categories stay in `tags`.
  inferCategory?: boolean
  // Optional fallback coordinates for sites whose venues lack geo (e.g. a single-location
  // org like Prospect Park or Green-Wood). Applied only when an event has no venue geo,
  // so the deterministic travel-time filter still works. Also used as a default venue
  // label when the feed omits one.
  defaultLatitude?: number
  defaultLongitude?: number
  defaultVenueName?: string
  defaultBorough?: string
  // Some sites (e.g. Prospect Park) sit behind a WAF that intermittently 403s server-side
  // requests even with a browser UA. When true, a failed direct fetch is retried through
  // the r.jina.ai reader proxy, which fetches with a real browser fingerprint and returns
  // the JSON body untouched (via the `x-respond-with: text` header).
  useProxyFallback?: boolean
}

// Raw shape of a Tribe event (only the fields we use).
type TribeEvent = {
  title?: string
  description?: string
  url?: string
  utc_start_date?: string // "YYYY-MM-DD HH:mm:ss" in UTC
  utc_end_date?: string
  cost?: string
  categories?: { name?: string; slug?: string }[]
  tags?: { name?: string }[]
  venue?: { venue?: string; address?: string; city?: string; state?: string; zip?: string; geo_lat?: string | number; geo_lng?: string | number }
  image?: { url?: string } | string
  id?: number | string
}

type TribeResponse = { events?: TribeEvent[]; total_pages?: number; total?: number }

// Safety cap. Category-filtered feeds are tiny; unfiltered ones (e.g. Prospect Park) lean
// on the ascending-order early-break below, so this just bounds the worst case.
const MAX_PAGES = 12
const PER_PAGE = 50

// Some Tribe sites sit behind a WAF that 403s non-browser User-Agents (e.g. Prospect
// Park), so we present a realistic browser UA. The endpoint is still a public JSON API.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Decode the HTML entities WordPress emits in titles/descriptions (e.g. &#8217; &amp;).
function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
}

// Strip HTML tags from a description and collapse whitespace.
function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
}

// "YYYY-MM-DD HH:mm:ss" (UTC) -> ISO "YYYY-MM-DDTHH:mm:ssZ".
function utcToISO(raw?: string): string | null {
  if (!raw) return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw.trim())
  if (!m) return null
  return `${m[1]}T${m[2]}Z`
}

function numberOrNull(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function imageUrl(image: TribeEvent["image"]): string | null {
  if (!image) return null
  if (typeof image === "string") return image || null
  return image.url || null
}

// Build a single-line postal address from the venue parts, when present.
function venueAddress(v: TribeEvent["venue"]): string | null {
  if (!v) return null
  const parts = [v.address, v.city, v.state, v.zip].map((p) => (p || "").toString().trim()).filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : null
}

// Fetch one Tribe API page as parsed JSON. Tries a direct request first; if that fails and
// the source opted into the proxy fallback, retries through the r.jina.ai reader proxy.
// Returns null for an expected "past the last page" 400 so the caller can stop paginating.
async function fetchTribePage(
  url: string,
  config: TribeSourceConfig,
  page: number,
): Promise<TribeResponse | null> {
  const direct = await fetch(url, { headers: { Accept: "application/json", "User-Agent": BROWSER_UA } })
  if (direct.ok) return (await direct.json()) as TribeResponse
  // A 400 past the last page is expected; signal "stop" rather than error.
  if (direct.status === 400 && page > 1) return null

  if (config.useProxyFallback) {
    // The proxy returns the raw JSON body; `x-respond-with: text` avoids markdown wrapping.
    // We slice from the first "{" defensively in case any preamble is prepended.
    const proxied = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "x-respond-with": "text", "User-Agent": BROWSER_UA },
    })
    if (proxied.ok) {
      const raw = await proxied.text()
      const start = raw.indexOf("{")
      if (start !== -1) {
        try {
          return JSON.parse(raw.slice(start)) as TribeResponse
        } catch {
          // fall through to the error below
        }
      }
    }
  }

  throw new Error(`${config.name} feed returned HTTP ${direct.status}`)
}

export function createTribeSource(config: TribeSourceConfig): EventSource {
  return {
    name: config.name,
    enabled: config.enabled ?? true,

    async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
      const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
      const startWindow = nyMidnightToday().getTime()
      const endWindow = startWindow + horizonDays * 86400000

      const base =
        `${config.baseUrl}/wp-json/tribe/events/v1/events` +
        `?per_page=${PER_PAGE}&start_date=${todayNY}` +
        (config.categorySlug ? `&categories=${encodeURIComponent(config.categorySlug)}` : "")

      const out: NormalizedEvent[] = []
      let page = 1
      let totalPages = 1
      do {
        const data = await fetchTribePage(`${base}&page=${page}`, config, page)
        if (!data) break // past the last page
        totalPages = data.total_pages ?? 1

        // The feed is ordered by start date ascending, so once a page's earliest event is
        // already beyond our window we've seen everything relevant and can stop paginating.
        // This matters for busy sources (Prospect Park has 1,000+ future events) so we don't
        // burn pages — and proxy calls — pulling events months away.
        const firstStart = utcToISO((data.events || [])[0]?.utc_start_date)
        if (firstStart && new Date(firstStart).getTime() > endWindow) break

        for (const e of data.events || []) {
          const title = e.title ? decodeEntities(e.title) : ""
          const start = utcToISO(e.utc_start_date)
          const url = e.url?.trim()
          if (!title || !start || !url) continue

          const end = utcToISO(e.utc_end_date)
          // Keep events whose [start, end] span overlaps the rolling window.
          const startMs = new Date(start).getTime()
          const endMs = end ? new Date(end).getTime() : startMs
          if (endMs < startWindow) continue
          if (startMs > endWindow) continue

          const siteCategories = (e.categories || []).map((c) => c?.name).filter(Boolean) as string[]
          const siteTags = (e.tags || []).map((t) => t?.name).filter(Boolean) as string[]
          const tags = [...new Set([...siteCategories, ...siteTags])]
          const venueName = e.venue?.venue?.trim() || config.defaultVenueName || null

          // Use the feed's own coordinates when present; otherwise fall back to the
          // source's known location so travel-time filtering still applies.
          const feedLat = numberOrNull(e.venue?.geo_lat)
          const feedLng = numberOrNull(e.venue?.geo_lng)
          const lat = feedLat ?? config.defaultLatitude ?? null
          const lng = feedLng ?? config.defaultLongitude ?? null
          // Exact ONLY when the feed gave real per-venue coordinates. Anything else is
          // approximate: an org-level fallback (e.g. Green-Wood center) OR no coordinates
          // at all (e.g. SummerStage's borough-only venues) — in both cases we can't trust
          // the travel time, so the user's "exact venue only" toggle should hide them.
          const approximate = !(feedLat !== null && feedLng !== null)

          out.push({
            id: deterministicId([config.name, String(e.id || `${title}|${start}`)]),
            title,
            description: e.description ? stripHtml(e.description) : null,
            source: config.name,
            source_event_id: e.id !== undefined ? String(e.id) : null,
            event_url: url,
            venue_name: venueName,
            address: venueAddress(e.venue),
            latitude: lat,
            longitude: lng,
            borough: config.defaultBorough || null,
            neighborhood: null,
            // Category resolution, in priority order:
            //  1. Title/description inference (when enabled) — for sites whose categories
            //     describe format not topic; routes e.g. a jazz night to "Live music".
            //  2. categoryOverride — a fixed source-wide category (e.g. Poster House → Museums).
            //  3. The site's own last category — the default for well-tagged feeds.
            // Site categories are always preserved in `tags` regardless.
            category:
              (config.inferCategory ? inferCategoryFromText(title, e.description) : null) ||
              config.categoryOverride ||
              siteCategories[siteCategories.length - 1] ||
              null,
            tags: tags.length > 0 ? tags : null,
            organizer: config.organizer || null,
            start_time: start,
            end_time: end,
            price: e.cost?.trim() || null,
            currency: "USD",
            image_url: imageUrl(e.image),
            approximate_location: approximate,
          })
        }
        page++
      } while (page <= totalPages && page <= MAX_PAGES)

      return out
    },
  }
}
