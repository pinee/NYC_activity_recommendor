import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyMidnightToday } from "./util"

// NYC Photo Stroll (photostroll.nyc) — community photowalks around the city. The /events page
// is a static shell that just embeds a public Google Calendar; the same calendar is exposed as
// a public iCal (.ics) feed, which is the clean, structured source we read here.
//
// Events are in-person photowalks with a real (free-text) meeting location but NO coordinates,
// so we infer the borough from the location string and mark the location approximate.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Public iCal feed backing the calendar embedded on https://photostroll.nyc/events.
const ICS_URL =
  "https://calendar.google.com/calendar/ical/9njrqems47au78lkc4ul9civog%40group.calendar.google.com/public/basic.ics"

const SOURCE = "NYC Photo Stroll"

type VEvent = Record<string, { params: Record<string, string>; value: string }>

// Unfold RFC-5545 folded lines: a CRLF followed by a space/tab continues the previous line.
function unfold(ics: string): string {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "")
}

// Unescape iCal TEXT values (\\ \, \; \n).
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim()
}

// Split the feed into VEVENT blocks, each parsed into a map of PROPERTY -> {params, value}.
function parseVEvents(ics: string): VEvent[] {
  const lines = unfold(ics).split("\n")
  const events: VEvent[] = []
  let cur: VEvent | null = null
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {}
    } else if (line === "END:VEVENT") {
      if (cur) events.push(cur)
      cur = null
    } else if (cur) {
      const idx = line.indexOf(":")
      if (idx === -1) continue
      const left = line.slice(0, idx)
      const value = line.slice(idx + 1)
      const [name, ...paramParts] = left.split(";")
      const params: Record<string, string> = {}
      for (const p of paramParts) {
        const eq = p.indexOf("=")
        if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1)
      }
      cur[name.toUpperCase()] = { params, value }
    }
  }
  return events
}

// Convert an iCal date/time property to a UTC ISO timestamp.
// Handles: UTC ("...Z"), floating/TZID local (treated as NYC), and all-day (VALUE=DATE).
function icalToUtcISO(prop: { params: Record<string, string>; value: string } | undefined): string | null {
  if (!prop) return null
  const v = prop.value.trim()
  // All-day date: YYYYMMDD -> treat as midnight NYC.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly || prop.params.VALUE === "DATE") {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v)
    if (!m) return null
    return nyWallToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0)
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v)
  if (!dt) return null
  const [, y, mo, d, hh, mm, ss, z] = dt
  if (z === "Z") {
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
    ).toISOString()
  }
  // Floating or TZID-qualified local time — interpret as NYC wall-clock.
  return nyWallToUtc(Number(y), Number(mo), Number(d), Number(hh), Number(mm))
}

// NYC wall-clock -> UTC ISO, accounting for DST.
function nyWallToUtc(y: number, mo: number, d: number, hh: number, mm: number): string {
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm)
  const nyStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "America/New_York" })
  const utcStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" })
  const offsetMs = new Date(utcStr).getTime() - new Date(nyStr).getTime()
  return new Date(utcGuess + offsetMs).toISOString()
}

const BOROUGHS: { re: RegExp; borough: string }[] = [
  { re: /\bbrooklyn\b|\bbklyn\b/i, borough: "Brooklyn" },
  { re: /\bqueens\b|\bastoria\b|\blong island city\b|\blic\b|\bflushing\b|\bjackson heights\b/i, borough: "Queens" },
  { re: /\bbronx\b/i, borough: "Bronx" },
  { re: /\bstaten island\b/i, borough: "Staten Island" },
  { re: /\bmanhattan\b|\bharlem\b|\bchelsea\b|\bsoho\b|\btribeca\b|\bmidtown\b|\blower east side\b/i, borough: "Manhattan" },
]

function inferBorough(location: string): string | null {
  for (const { re, borough } of BOROUGHS) if (re.test(location)) return borough
  return null
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/calendar" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export const photostrollSource: EventSource = {
  name: SOURCE,
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const ics = await fetchText(ICS_URL)
    if (!ics) return []

    const startWindow = nyMidnightToday().getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    for (const ev of parseVEvents(ics)) {
      const startISO = icalToUtcISO(ev.DTSTART)
      if (!startISO) continue
      const startMs = new Date(startISO).getTime()
      if (!Number.isFinite(startMs)) continue

      const endISO = icalToUtcISO(ev.DTEND)
      const endMs = endISO ? new Date(endISO).getTime() : startMs
      // Keep events whose span overlaps the rolling window.
      if ((Number.isFinite(endMs) ? endMs : startMs) < startWindow) continue
      if (startMs > endWindow) continue

      const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.value) : ""
      if (!title) continue

      const location = ev.LOCATION ? unescapeText(ev.LOCATION.value) : ""
      const uid = ev.UID?.value?.trim() || `${title}-${startISO}`
      const url = ev.URL?.value?.trim() || "https://photostroll.nyc/events"

      out.push({
        id: deterministicId([SOURCE, uid]),
        title,
        description: ev.DESCRIPTION ? unescapeText(ev.DESCRIPTION.value) : null,
        source: SOURCE,
        source_event_id: uid,
        event_url: url,
        venue_name: location || null,
        address: location || null,
        latitude: null,
        longitude: null,
        borough: inferBorough(location),
        neighborhood: null,
        // Community photowalks — always the Photography interest.
        category: "Photography",
        tags: ["Photography", "Photowalk"],
        organizer: SOURCE,
        start_time: startISO,
        end_time: endISO && endMs !== startMs ? endISO : null,
        price: null,
        currency: "USD",
        image_url: null,
        // iCal carries only a free-text location, no coordinates.
        approximate_location: true,
      })
    }

    return out
  },
}
