import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyMidnightToday, nyToUtcISO, parseClockTo24h } from "./util"

// Bike New York (bike.nyc/calendar) — the org behind the TD Five Boro Bike Tour, free
// education rides, and guided local rides. Its /events index is just annual campaign landing
// pages with no dates, but /calendar renders the actual dated schedule as server-side HTML.
//
// Each event is an <article> with a structured date/​info block:
//   <span class="event-date"><span class="month">Jun</span><span class="day">28</span>
//     <span class="thru">Thru Jul 28</span></span>            (thru is optional, and may be
//                                                              "Thru Jul 28" or day-only "Thru 29")
//   <div class="event-info"><p class="post-category">Event</p><h3>Title</h3>
//     <p class="post-location">…</p><p class="post-time"><span>9:00 AM-12:00 PM</span></p>
//     <a class="inline-cta" href="…/events/…/">More Info</a></div>
//
// Dates are year-less, so we infer the year relative to today (shared monthDayToNyDate). These
// are all cycling events (category is always the generic "Event"), so we classify as "Cycling".
// Locations are free-text with no coordinates, so we mark the location approximate.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const URL = "https://www.bike.nyc/calendar/"

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
}

function firstMatch(block: string, re: RegExp): string | null {
  const m = re.exec(block)
  return m ? decodeEntities(m[1]) : null
}

// Normalize hour-only clocks ("9 AM" -> "9:00 AM") so the shared HH:MM parser accepts them,
// then take the start side of a "9:00 AM-12:00 PM" / "7:30AM - 5:30PM" range.
function startClock(rawTime: string | null): string {
  if (!rawTime) return ""
  const first = rawTime.split(/\s*(?:to|–|-|—)\s*/i)[0] || ""
  const cleaned = first.trim().replace(/^(\d{1,2})\s*([ap]\.?m\.?)$/i, "$1:00 $2")
  return parseClockTo24h(cleaned)
}

// The largest srcset candidate (or a plain src) from the event's background image.
function extractImage(block: string): string | null {
  const srcset = /<img[^>]*srcset="([^"]*)"/i.exec(block)
  if (srcset) {
    const candidates = srcset[1]
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0])
      .filter((u) => /^https?:\/\//.test(u))
    if (candidates.length) return candidates[candidates.length - 1]
  }
  const src = /<img[^>]*\ssrc="(https?:\/\/[^"]+)"/i.exec(block)
  return src ? src[1] : null
}

// Resolve the "Thru …" end date. Two shapes appear: "Thru Jul 28" (month + day) and the
// day-only "Thru 29" (same month as the start). Returns a NY YYYY-MM-DD or null.
function resolveEndDate(
  thru: string | null,
  startMonth: string,
  startDate: string,
  todayNY: Date,
): string | null {
  if (!thru) return null
  const cleaned = thru.replace(/^thru\s+/i, "").trim()
  const md = /^([A-Za-z]{3,})\s+(\d{1,2})$/.exec(cleaned)
  if (md) return monthDayToNyDate(md[1], Number(md[2]), todayNY)
  const dayOnly = /^(\d{1,2})$/.exec(cleaned)
  if (dayOnly) {
    // Same month/year as the start; if the day is smaller than the start day the range
    // wraps into the next month.
    const [sy, sm, sd] = startDate.split("-").map(Number)
    const endDay = Number(dayOnly[1])
    let y = sy
    let m = sm
    if (endDay < sd) {
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
    return `${y}-${String(m).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`
  }
  return null
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

export const bikeNycSource: EventSource = {
  name: "Bike New York",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const html = await fetchText(URL)
    if (!html) return []

    const todayNY = nyMidnightToday()
    const startWindow = todayNY.getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []

    for (const art of html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)) {
      const block = art[1]

      const title = firstMatch(block, /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i)
      if (!title) continue

      const month = firstMatch(block, /class="month">([^<]*)</i)
      const dayText = firstMatch(block, /class="day">([^<]*)</i)
      if (!month || !dayText) continue
      const day = Number(dayText.replace(/\D/g, ""))
      if (!day) continue

      const startDate = monthDayToNyDate(month, day, todayNY)
      if (!startDate) continue

      const thru = firstMatch(block, /class="thru">([^<]*)</i)
      const endDate = resolveEndDate(thru, month, startDate, todayNY)

      const timeText = firstMatch(block, /class="post-time">\s*<span>([^<]*)</i)
      const time = startClock(timeText) || "00:00"

      const startISO = nyToUtcISO(startDate, time)
      if (!startISO) continue
      const endISO = endDate ? nyToUtcISO(endDate, "23:59") : null

      // Keep an event when any part of its run falls inside the horizon window: a multi-day
      // event already underway (start in the past, end in the future) is still relevant today.
      const startMs = new Date(startISO).getTime()
      const endMs = endISO ? new Date(endISO).getTime() : startMs
      if (endMs < startWindow || startMs > endWindow) continue

      const location = firstMatch(block, /class="post-location">([\s\S]*?)<\/p>/i)
      const href = firstMatch(block, /class="inline-cta"[^>]*href="([^"]*)"/i)
      const image = extractImage(block)

      out.push({
        id: deterministicId(["Bike New York", title, startDate]),
        title,
        description: null,
        source: "Bike New York",
        source_event_id: null,
        event_url: href || URL,
        venue_name: location ? location.split("(")[0].trim() || null : null,
        address: location,
        latitude: null,
        longitude: null,
        borough: null,
        neighborhood: null,
        category: "Cycling",
        tags: ["Cycling", "Bike New York"],
        organizer: "Bike New York",
        start_time: startISO,
        end_time: endISO,
        price: null,
        currency: "USD",
        image_url: image,
        // Only a free-text location is published (no coordinates), so travel-time estimates
        // for these events are approximate.
        approximate_location: true,
      })
    }

    return out
  },
}
