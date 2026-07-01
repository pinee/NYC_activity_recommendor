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

// Infer an app interest-category from free text (an event title, optionally + description).
// This intentionally does NOT reuse INTEREST_KEYWORDS from lib/types: those are tuned for
// substring matching against the short, controlled `category` field, and are too noisy for
// free-form titles (e.g. "walk" in "sidewalk", "park" in "parking"). Here we use tighter
// word-boundary patterns, ordered most-specific-first so "Jazz Concert in the Park" resolves
// to "Live music" rather than "Hiking & parks". Returns null when nothing matches confidently,
// letting the caller fall back to a source default (or the "Others" catch-all).
const CATEGORY_PATTERNS: { category: string; re: RegExp }[] = [
  { category: "Live music", re: /\b(jazz|concert|orchestra|symphony|band|choir|opera|DJ|live music|singer|vocalist|recital)\b/i },
  { category: "Theater", re: /\b(theater|theatre|broadway|play|musical|drama|opera|cabaret)\b/i },
  { category: "Comedy", re: /\b(comedy|comedian|stand-?up|improv)\b/i },
  { category: "Dance", re: /\b(dance|ballet|salsa|tango|choreograph)\w*/i },
  { category: "Film & cinema", re: /\b(film|movie|cinema|screening)\b/i },
  { category: "Books & readings", re: /\b(book|author|reading|poetry|literary|storytime|memoir)\b/i },
  { category: "Talks & lectures", re: /\b(talk|lecture|panel|seminar|symposium|keynote|conversation|discussion)\b/i },
  { category: "Art & galleries", re: /\b(gallery|exhibit|painting|sculpture|mural|artist|drawing|printmaking)\b/i },
  { category: "Museums", re: /\b(museum|curator|curatorial|docent)\b/i },
  { category: "Food & dining", re: /\b(food|dining|tasting|culinary|cooking|brunch|dinner|chef|wine|beer|cocktail)\b/i },
  { category: "Coffee & cafes", re: /\b(coffee|espresso|cafe|café)\b/i },
  { category: "Yoga & wellness", re: /\b(yoga|wellness|meditation|mindfulness|pilates|tai chi)\b/i },
  { category: "Running & fitness", re: /\b(run|running|fitness|workout|bootcamp|marathon|weightlifting|strength)\b/i },
  { category: "Cycling", re: /\b(cycling|bike|bicycle)\b/i },
  { category: "Swimming & pools", re: /\b(swim|swimming|aquatics?)\b/i },
  { category: "Hiking & parks", re: /\b(hike|hiking|trail|nature|birding|kayak|canoe|fishing)\b/i },
  { category: "Markets & shopping", re: /\b(market|bazaar|flea|pop-?up|vendor)\b/i },
  { category: "Tech & startups", re: /\b(tech|startup|coding|hackathon|developer)\b/i },
  { category: "Sports & games", re: /\b(basketball|soccer|tennis|baseball|volleyball|chess|pickleball|tournament)\b/i },
  { category: "Photography", re: /\b(photography|photo walk|photographer)\b/i },
  { category: "Family & kids", re: /\b(kids?|family|children|toddler|storytime)\b/i },
  { category: "Festivals & fireworks", re: /\b(festival|fireworks?|parade|celebration)\b/i },
]

export function inferCategoryFromText(...parts: (string | null | undefined)[]): string | null {
  const hay = parts.filter(Boolean).join(" ")
  if (!hay.trim()) return null
  for (const { category, re } of CATEGORY_PATTERNS) {
    if (re.test(hay)) return category
  }
  return null
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

// Convert a year-less "month + day" (e.g. "Jun", 25) into a NY "YYYY-MM-DD" string,
// inferring the year relative to today. Several of our sources render dates without a
// year ("Jun 25", "Sun, Jun 28"); we assume the next occurrence, only rolling to next
// year when the date is well in the past (>120 days) to avoid a calendar-wrap mistake.
export function monthDayToNyDate(monthName: string, day: number, todayNY: Date): string | null {
  const mo = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()]
  if (mo === undefined || !day || day < 1 || day > 31) return null
  let year = todayNY.getFullYear()
  const candidate = new Date(year, mo, day)
  const todayMidnight = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
  if (candidate.getTime() < todayMidnight.getTime() - 120 * 86400000) year += 1
  return `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
