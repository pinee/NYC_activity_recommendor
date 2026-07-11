import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday } from "./util"

// Whitney Museum of American Art (whitney.org) — talks, tours, performances, film, and
// family programs tied to its exhibitions (e.g. the Whitney Biennial). The site is a custom
// Rails app with NO Tribe/WordPress JSON API, but every individual event page embeds a clean
// schema.org JSON-LD "Event" object (name, startDate/endDate with correct -04:00/-05:00
// offset, location + postal address, image). So we scrape the /events index for event slugs,
// then fetch each event page and read its JSON-LD — far more reliable than parsing prose.
//
// Single-venue institution: all programs happen at the Meatpacking building (99 Gansevoort
// St), so JSON-LD carries exact per-event coordinates via the shared museum address and we
// treat the location as exact.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const BASE = "https://whitney.org"
// The museum's building coordinates (99 Gansevoort St), used when JSON-LD omits geo.
const WHITNEY_LAT = 40.7396
const WHITNEY_LNG = -74.0089
// Safety cap on how many event detail pages we fetch per run.
const MAX_EVENTS = 60

type JsonLdEvent = {
  "@type"?: string | string[]
  name?: string
  description?: string
  startDate?: string
  endDate?: string
  url?: string
  image?: string | { url?: string } | (string | { url?: string })[]
  offers?: { price?: string; priceCurrency?: string } | { price?: string; priceCurrency?: string }[]
  location?: {
    name?: string
    geo?: { latitude?: number | string; longitude?: number | string }
    address?: { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string }
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
    .replace(/[\u200b\u200e\u200f]/g, "") // zero-width / bidi marks the site sprinkles into titles
    .replace(/\s+/g, " ")
    .trim()
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Pull the first schema.org Event JSON-LD object out of a page's HTML.
function extractEventJsonLd(html: string): JsonLdEvent | null {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []
  for (const block of blocks) {
    const jsonText = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      continue
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    for (const c of candidates as JsonLdEvent[]) {
      const type = c?.["@type"]
      const isEvent = Array.isArray(type) ? type.includes("Event") : type === "Event"
      if (isEvent && c.startDate) return c
    }
  }
  return null
}

function firstImage(image: JsonLdEvent["image"]): string | null {
  if (!image) return null
  if (typeof image === "string") return image
  if (Array.isArray(image)) {
    const first = image[0]
    return typeof first === "string" ? first : first?.url || null
  }
  return image.url || null
}

function firstOffer(offers: JsonLdEvent["offers"]): { price: string | null; currency: string | null } {
  const o = Array.isArray(offers) ? offers[0] : offers
  if (!o) return { price: null, currency: null }
  return { price: o.price != null ? String(o.price) : null, currency: o.priceCurrency || null }
}

function numberOrNull(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export const whitneySource: EventSource = {
  name: "Whitney Museum",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const indexHtml = await fetchText(`${BASE}/events`)
    if (!indexHtml) return []

    // Collect unique event slugs in document order.
    const slugs: string[] = []
    for (const m of indexHtml.matchAll(/href="(\/events\/[^"#?]+)"/g)) {
      const path = m[1]
      if (!slugs.includes(path)) slugs.push(path)
    }

    const out: NormalizedEvent[] = []
    for (const path of slugs.slice(0, MAX_EVENTS)) {
      const url = `${BASE}${path}`
      const html = await fetchText(url)
      if (!html) continue
      const ld = extractEventJsonLd(html)
      if (!ld || !ld.startDate) continue

      const startMs = new Date(ld.startDate).getTime()
      if (!Number.isFinite(startMs)) continue
      const endMs = ld.endDate ? new Date(ld.endDate).getTime() : startMs
      // Keep events whose span overlaps the rolling window.
      if ((Number.isFinite(endMs) ? endMs : startMs) < startWindow) continue
      if (startMs > endWindow) continue

      const title = ld.name ? decodeEntities(ld.name) : ""
      if (!title) continue

      const loc = ld.location
      const addr = loc?.address
      const address = addr
        ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
            .map((p) => (p || "").toString().trim())
            .filter(Boolean)
            .join(", ")
        : "99 Gansevoort St, New York, NY 10014"
      const lat = numberOrNull(loc?.geo?.latitude) ?? WHITNEY_LAT
      const lng = numberOrNull(loc?.geo?.longitude) ?? WHITNEY_LNG
      const { price, currency } = firstOffer(ld.offers)

      out.push({
        id: deterministicId(["Whitney Museum", path]),
        title,
        description: ld.description ? decodeEntities(ld.description) : null,
        source: "Whitney Museum",
        source_event_id: path.replace("/events/", ""),
        event_url: ld.url || url,
        venue_name: loc?.name || "Whitney Museum of American Art",
        address,
        latitude: lat,
        longitude: lng,
        borough: "Manhattan",
        neighborhood: "Meatpacking District",
        // Whitney programs are museum events; keep them under the Museums interest.
        category: "Museums",
        tags: ["Museums", "Whitney Museum"],
        organizer: "Whitney Museum of American Art",
        start_time: new Date(startMs).toISOString(),
        end_time: Number.isFinite(endMs) && endMs !== startMs ? new Date(endMs).toISOString() : null,
        price: price && price !== "0" ? price : null,
        currency: currency || "USD",
        image_url: firstImage(ld.image),
        // JSON-LD carries the museum's exact building coordinates, so this is a precise location.
        approximate_location: false,
      })
    }

    return out
  },
}
