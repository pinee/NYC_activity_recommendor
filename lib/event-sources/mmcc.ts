import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday } from "./util"

// Metropolitan Manhattan Camera Club (mmcc-nyc.org) — a photography club whose calendar is a
// Wix Events widget. Wix renders the events client-side, but the viewer REST API is reachable
// with the short-lived "instance" auth token embedded in the calendar page HTML. So we: (1)
// fetch /calendar to scrape the fresh instance token, (2) call the Wix Events list endpoint,
// (3) normalize the JSON. Events are club programs/competitions — mostly online, occasionally
// at a NYC venue — so we classify the whole source as Photography.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const SOURCE = "Metropolitan Manhattan Camera Club"
const CALENDAR_URL = "https://www.mmcc-nyc.org/calendar"
// Wix Events viewer REST endpoint. `fieldset` params are required to get scheduling/text data.
const API_URL =
  "https://www.mmcc-nyc.org/_api/wix-events-web/v1/events?limit=100&fieldset=DETAILS&fieldset=TEXTS"
// appDefId of the Wix Events app — used to pick the right "instance" token off the page (a Wix
// site embeds a separate token per installed app).
const WIX_EVENTS_APP_DEF_ID = "140603ad-af8d-84a5-2c80-a0f60cb47351"

type WixLocation = {
  name?: string
  type?: string // "ONLINE" | "VENUE"
  tbd?: boolean
  address?: string
  coordinates?: { lat?: number; lng?: number }
}
type WixEvent = {
  id?: string
  title?: string
  description?: string
  slug?: string
  status?: string
  location?: WixLocation
  scheduling?: { config?: { startDate?: string; endDate?: string; timeZoneId?: string } }
  mainImage?: { url?: string }
}

// Decode the base64url JWT-style payload of a Wix instance token (no signature check needed).
function decodeInstancePayload(token: string): { appDefId?: string } | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return JSON.parse(json)
  } catch {
    return null
  }
}

// Pick the "instance" token belonging to the Wix Events app. The page embeds one token per
// installed app, so we decode each and match on the Events appDefId (falling back to the first
// token if none match, to stay resilient to Wix internal changes).
function extractInstance(html: string): string | null {
  const tokens = [...html.matchAll(/"instance":"([A-Za-z0-9._-]{40,})"/g)].map((m) => m[1])
  for (const t of tokens) {
    if (decodeInstancePayload(t)?.appDefId === WIX_EVENTS_APP_DEF_ID) return t
  }
  return tokens[0] ?? null
}

// Fetch the calendar page with a cache-busting query param. Wix serves the page through a CDN
// that ignores Cache-Control headers and will hand back a stale copy whose embedded instance
// token has already expired (→ 401 from the API); a unique query string forces a fresh render.
async function fetchCalendarPage(): Promise<string | null> {
  try {
    const url = `${CALENDAR_URL}?_=${Date.now()}`
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export const mmccSource: EventSource = {
  name: SOURCE,
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const page = await fetchCalendarPage()
    if (!page) return []
    const instance = extractInstance(page)
    if (!instance) return []

    let data: { events?: WixEvent[] }
    try {
      const res = await fetch(API_URL, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json", Authorization: instance },
      })
      if (!res.ok) return []
      data = (await res.json()) as { events?: WixEvent[] }
    } catch {
      return []
    }

    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    for (const ev of data.events ?? []) {
      if (ev.status === "CANCELED") continue
      const cfg = ev.scheduling?.config
      const startISO = cfg?.startDate
      if (!startISO) continue
      const startMs = new Date(startISO).getTime()
      if (!Number.isFinite(startMs)) continue
      const endMs = cfg?.endDate ? new Date(cfg.endDate).getTime() : startMs
      // Keep events whose span overlaps the rolling window (drops the club's past season).
      if ((Number.isFinite(endMs) ? endMs : startMs) < startWindow) continue
      if (startMs > endWindow) continue

      const title = (ev.title || "").trim()
      if (!title) continue

      const loc = ev.location
      const isOnline = loc?.type === "ONLINE"
      const coords = loc?.coordinates
      // Only trust coordinates for a real, non-TBD physical venue.
      const hasRealVenue = loc?.type === "VENUE" && !loc?.tbd && !!coords?.lat && !!coords?.lng
      const slug = ev.slug ? `https://www.mmcc-nyc.org/event-details/${ev.slug}` : CALENDAR_URL

      out.push({
        id: deterministicId([SOURCE, ev.id || ev.slug || `${title}-${startISO}`]),
        title,
        description: ev.description ? ev.description.trim() : null,
        source: SOURCE,
        source_event_id: ev.id || ev.slug || null,
        event_url: slug,
        venue_name: isOnline ? "Online" : loc?.name || null,
        address: hasRealVenue ? loc?.address || null : isOnline ? "Online" : null,
        latitude: hasRealVenue ? coords!.lat! : null,
        longitude: hasRealVenue ? coords!.lng! : null,
        borough: hasRealVenue ? "Manhattan" : null,
        neighborhood: null,
        // Camera-club programming — always the Photography interest.
        category: "Photography",
        tags: isOnline ? ["Photography", "Online"] : ["Photography"],
        organizer: SOURCE,
        start_time: new Date(startMs).toISOString(),
        end_time: Number.isFinite(endMs) && endMs !== startMs ? new Date(endMs).toISOString() : null,
        price: null,
        currency: "USD",
        image_url: ev.mainImage?.url || null,
        // Online events have no physical location; physical ones use Wix-provided geocode.
        approximate_location: !hasRealVenue,
      })
    }

    return out
  },
}
