import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// NYC for Free (nycforfree.co) curates free events across the city. The site runs on
// Squarespace, whose event collections expose a clean JSON view at `?format=json`:
// { upcoming: [...], past: [...] }. Each event carries a millisecond-epoch startDate/endDate
// (already a UTC instant, so no timezone math is needed), a relative fullUrl, a location
// block with marker lat/lng + address lines, and categories/tags. This is a stable,
// server-fetchable feed — no proxy or scraping required.
const SOURCE_NAME = "NYC for Free"
const ORIGIN = "https://www.nycforfree.co"
const FEED_URL = `${ORIGIN}/events?format=json`
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Squarespace's default map centroid when an event has no precise address. Coordinates
// equal to this (within a small epsilon) are a fallback, not the real venue → approximate.
const FALLBACK_LAT = 40.7207559
const FALLBACK_LNG = -74.0007613

type SquarespaceEvent = {
  title?: string
  startDate?: number
  endDate?: number
  fullUrl?: string
  excerpt?: string
  body?: string
  assetUrl?: string
  categories?: string[]
  tags?: string[]
  location?: {
    markerLat?: number
    markerLng?: number
    addressLine1?: string
    addressLine2?: string
    addressTitle?: string
  }
}

// Squarespace `assetUrl`s are usually a real image file, but some records return a
// folder-only URL ending in a numeric id + trailing slash (e.g. ".../1778607035803/"),
// which 302s to an empty body and renders as a broken image. Accept a URL only when its
// final path segment looks like an actual file (has an extension), otherwise drop it.
function validImageUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "")
    const last = path.slice(path.lastIndexOf("/") + 1)
    return /\.[a-z0-9]{2,5}$/i.test(last) ? url : null
  } catch {
    return null
  }
}

function stripHtml(s: string | null | undefined): string {
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

// Map the event's own categories/tags/title/excerpt to one of our canonical interests.
function inferCategory(ev: SquarespaceEvent): string {
  const hay = [
    ...(ev.categories || []),
    ...(ev.tags || []),
    ev.title || "",
    stripHtml(ev.excerpt),
  ]
    .join(" ")
    .toLowerCase()
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hasWord(hay, k))) return interest
  }
  return "Others"
}

// Approximate the borough from the address text when present.
function inferBorough(addr: string): string | null {
  const a = addr.toLowerCase()
  if (/brooklyn|\bbk\b/.test(a)) return "Brooklyn"
  if (/queens|astoria|long island city|\blic\b|flushing|jamaica/.test(a)) return "Queens"
  if (/bronx/.test(a)) return "Bronx"
  if (/staten island/.test(a)) return "Staten Island"
  if (/manhattan|new york, ny|nyc|harlem|\bny\b/.test(a)) return "Manhattan"
  return null
}

export const nycForFreeSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }) {
    const res = await fetch(FEED_URL, {
      headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { upcoming?: SquarespaceEvent[] }
    const events = data.upcoming || []

    const now = Date.now()
    const startMs = now - 12 * 3600_000 // small grace for events earlier today
    const endMs = now + horizonDays * 86400_000

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    for (const ev of events) {
      if (!ev.title || typeof ev.startDate !== "number") continue
      if (ev.startDate < startMs || ev.startDate > endMs) continue

      const url = ev.fullUrl ? `${ORIGIN}${ev.fullUrl}` : ORIGIN
      if (seen.has(url)) continue
      seen.add(url)

      const loc = ev.location || {}
      const addr = [loc.addressLine1, loc.addressLine2].filter(Boolean).join(", ").trim()
      const hasCoords = typeof loc.markerLat === "number" && typeof loc.markerLng === "number"
      const isFallbackCoord =
        hasCoords &&
        Math.abs((loc.markerLat as number) - FALLBACK_LAT) < 0.0005 &&
        Math.abs((loc.markerLng as number) - FALLBACK_LNG) < 0.0005
      // Exact only when we have coordinates AND a real street address that isn't the
      // Squarespace default centroid.
      const exact = hasCoords && !!loc.addressLine1 && !isFallbackCoord

      const description = stripHtml(ev.excerpt) || stripHtml(ev.body).slice(0, 300) || null

      out.push({
        id: deterministicId([SOURCE_NAME, url]),
        title: ev.title,
        description,
        source: SOURCE_NAME,
        source_event_id: ev.fullUrl || url,
        event_url: url,
        venue_name: loc.addressTitle || null,
        address: addr || null,
        latitude: hasCoords ? (loc.markerLat as number) : null,
        longitude: hasCoords ? (loc.markerLng as number) : null,
        borough: addr ? inferBorough(addr) : null,
        neighborhood: null,
        category: inferCategory(ev),
        tags: ["nyc for free", "free", ...(ev.categories || []).map((c) => c.toLowerCase())],
        organizer: "NYC for Free",
        // startDate is a UTC epoch (ms) — already the correct instant.
        start_time: new Date(ev.startDate).toISOString(),
        end_time: typeof ev.endDate === "number" ? new Date(ev.endDate).toISOString() : null,
        price: "Free",
        currency: "USD",
        image_url: validImageUrl(ev.assetUrl),
        approximate_location: !exact,
      })
    }
    return out
  },
}
