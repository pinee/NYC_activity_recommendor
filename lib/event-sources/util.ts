import { createHash } from "crypto"

// Stable UUID derived from a source name + that source's own event id (or a fallback
// key). Re-ingesting the same event always produces the same id, so upsert on the
// primary key naturally de-duplicates across daily runs.
export function deterministicId(parts: string[]): string {
  const key = parts.map((p) => (p || "").toLowerCase().trim()).join("|")
  const h = createHash("sha256").update(key).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// Today (midnight) anchored to NYC time.
export function nyMidnightToday(): Date {
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
  ny.setHours(0, 0, 0, 0)
  return ny
}

// Convert a NYC wall-clock date (YYYY-MM-DD) + time (HH:MM, 24h) into a UTC ISO
// timestamp, correctly accounting for daylight saving time.
export function nyToUtcISO(date: string, time: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const [hh, mm] = (time && /^\d{1,2}:\d{2}$/.test(time) ? time : "00:00").split(":").map(Number)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm)
  const nyStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "America/New_York" })
  const utcStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" })
  const offsetMs = new Date(utcStr).getTime() - new Date(nyStr).getTime()
  return new Date(utcGuess + offsetMs).toISOString()
}

// Parse a clock string like "7:00 am" or "12:30 PM" into 24h "HH:MM".
// Returns "" when it can't be parsed (caller treats that as midnight).
export function parseClockTo24h(raw: string | null | undefined): string {
  if (!raw) return ""
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(raw.trim())
  if (!m) return ""
  let hour = Number(m[1])
  const min = Number(m[2])
  const ampm = m[3]?.toLowerCase()
  if (ampm === "pm" && hour < 12) hour += 12
  if (ampm === "am" && hour === 12) hour = 0
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

// Pull the YYYY-MM-DD part out of an ISO-ish date string (e.g. "2026-06-17T00:00:00.000").
export function isoDatePart(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim())
  return m ? m[1] : null
}
