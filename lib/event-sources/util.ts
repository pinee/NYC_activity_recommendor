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

// Canonical category assigned to World Cup / soccer VIEWING events so they all collect under
// the single "World Cup & Soccer" interest. Deliberately contains neither "soccer" nor
// "football" nor "sport"/"game", so these events route ONLY to the new interest and are not
// also swept up by the "Sports & games" interest keywords.
export const WORLD_CUP_CATEGORY = "World Cup Viewing"

// Detects genuine World Cup / soccer VIEWING events — watch parties, fan zones/villages,
// big-screen match screenings, broadcast-at-a-bar events — as opposed to participation
// (kids clinics, flag football), soccer-themed movies, or nature "world cup" ranger games.
// Used at ingest to re-stamp such events with WORLD_CUP_CATEGORY. Conservative by design:
// requires BOTH a soccer/World Cup reference AND a viewing signal (or the NYC Parks "Soccer"
// big-screen category), so ambiguous or non-viewing soccer events are left in their original
// category rather than mislabeled.
export function isWorldCupViewing(
  title: string | null | undefined,
  description?: string | null,
  category?: string | null,
): boolean {
  const text = `${title || ""} ${description || ""} ${category || ""}`.toLowerCase()
  if (!text.trim()) return false

  // Must be about soccer / the World Cup. (NYC Parks tags its big-screen matches "Soccer".)
  const hasSoccerContext =
    /\b(world cup|fifa|soccer|f[úu]tbol|footy)\b/.test(text) || (category || "").toLowerCase() === "soccer"
  if (!hasSoccerContext) return false

  // Exclude participation, kids clinics, American flag football, nature programs, and movies.
  const isExcluded =
    /\b(flag football|nature world cup|fantasy soccer|world saving soccer|children'?s soccer|kids'? soccer|youth soccer|soccer (clinic|lesson|league|series|draft|practice)|learn to play|movies under the stars)\b/.test(
      text,
    )
  if (isExcluded) return false

  // A viewing signal: watching/screening a match, a fan zone/village, or a bar watch party.
  const hasViewingSignal =
    /\b(watch part(y|ies)|viewing part(y|ies)|watch (the )?(game|match|cup)|big screen|on the big|fan (zone|village|fest|festival)|screening|showing (the )?(world cup|game|match)|broadcast|telemundo|open bar)\b/.test(
      text,
    )

  return hasViewingSignal || (category || "").toLowerCase() === "soccer"
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
