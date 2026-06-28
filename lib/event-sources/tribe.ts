import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday } from "./util"

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
  // Optional fallback coordinates for sites whose venues lack geo (e.g. a single-location
  // org like Prospect Park or Green-Wood). Applied only when an event has no venue geo,
  // so the deterministic travel-time filter still works. Also used as a default venue
  // label when the feed omits one.
  defaultLatitude?: number
  defaultLongitude?: number
  defaultVenueName?: string
  defaultBorough?: string
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

const MAX_PAGES = 6 // safety cap; with a category filter the feed is small
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
        const res = await fetch(`${base}&page=${page}`, {
          headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
        })
        if (!res.ok) {
          // A 400 past the last page is expected; otherwise surface the error.
          if (res.status === 400 && page > 1) break
          throw new Error(`${config.name} feed returned HTTP ${res.status}`)
        }
        const data = (await res.json()) as TribeResponse
        totalPages = data.total_pages ?? 1

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
          const lat = numberOrNull(e.venue?.geo_lat) ?? config.defaultLatitude ?? null
          const lng = numberOrNull(e.venue?.geo_lng) ?? config.defaultLongitude ?? null

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
            // Override keeps interest matching working when the site's own category
            // wording (e.g. "SummerStage") lacks our keywords. Originals live in tags.
            category: config.categoryOverride || siteCategories[siteCategories.length - 1] || null,
            tags: tags.length > 0 ? tags : null,
            organizer: config.organizer || null,
            start_time: start,
            end_time: end,
            price: e.cost?.trim() || null,
            currency: "USD",
            image_url: imageUrl(e.image),
          })
        }
        page++
      } while (page <= totalPages && page <= MAX_PAGES)

      return out
    },
  }
}
