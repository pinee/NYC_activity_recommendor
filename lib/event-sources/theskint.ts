import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO } from "./util"
import { INTEREST_KEYWORDS } from "@/lib/types"

// theskint.com "ongoing events" page. Unlike the rest of our sources this is NOT an API
// — it's a hand-written newsletter page, so we parse its prose bullets with regex.
// Each bullet is reliably shaped like:
//   ► thru 6/30: <title> : <venue (neighborhood)>, <price>. >>   (>> is a real link)
// The parse is best-effort: malformed bullets are skipped rather than guessed.
const SOURCE_NAME = "The Skint"
const PAGE_URL = "https://www.theskint.com/ongoing-events/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Decode the handful of HTML entities theskint emits, then drop tags / collapse space.
function decodeEntities(s: string): string {
  return s
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8230;/g, "...")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

// "6/30" + today -> NY date "YYYY-MM-DD", rolling to next year if the month/day has
// already passed (so a "thru 1/4" in December correctly lands in January).
function resolveEndDate(md: string, todayNY: Date): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(md.trim())
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  let year = todayNY.getFullYear()
  // If the target date is well before today, assume it's next year.
  const candidate = new Date(year, month - 1, day)
  const todayMidnight = new Date(todayNY.getFullYear(), todayNY.getMonth(), todayNY.getDate())
  if (candidate.getTime() < todayMidnight.getTime() - 2 * 86400000) year += 1
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// Pull a "venue (neighborhood)" pair out of the details text. Returns the venue phrase
// (the clause immediately before the parens) and the neighborhood (inside the parens).
function parseVenue(details: string): { venue: string | null; neighborhood: string | null } {
  const m = /([^.,:;()]+?)\s*\(([^)]+)\)/.exec(details)
  if (!m) return { venue: null, neighborhood: null }
  const venue = m[1].trim().replace(/^(at|presents|the)\s+/i, "").trim()
  const neighborhood = m[2].trim()
  return { venue: venue || null, neighborhood: neighborhood || null }
}

// Extract a human price label from the bullet, else null.
function parsePrice(text: string): string | null {
  if (/free admission|free entry|\bfree\b/i.test(text)) return "Free"
  if (/various prices|prices vary/i.test(text)) return "Various prices"
  const m = /\$\s?\d[\d.,]*(?:\s*[-–]\s*\$?\d[\d.,]*)?/.exec(text)
  return m ? m[0].replace(/\s+/g, "") : null
}

// Map the bullet text to one of our interest categories so the pre-filter can match it.
// Defaults to "Arts & Culture" (contains "art", so it still matches the Art interest).
function inferCategory(haystack: string): string {
  const hay = haystack.toLowerCase()
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some((k) => hay.includes(k))) return interest
  }
  return "Arts & Culture"
}

function parseBullets(html: string, todayNY: Date): NormalizedEvent[] {
  // Narrow to the article body so we don't parse nav/sidebar bullets.
  const bodyMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[\s\S]*?<\/article>/i)
  const body = bodyMatch ? bodyMatch[0] : html
  const chunks = body.split("\u25ba").slice(1) // each chunk starts after a ► bullet
  const out: NormalizedEvent[] = []
  const todayISO = `${todayNY.getFullYear()}-${String(todayNY.getMonth() + 1).padStart(2, "0")}-${String(
    todayNY.getDate(),
  ).padStart(2, "0")}`
  const startUtc = nyToUtcISO(todayISO, "00:00")

  for (const chunk of chunks) {
    // The first href in the chunk is the event's real link (the ">>").
    const url = (chunk.match(/href="([^"]+)"/) || [])[1] || null
    // Cut at the ">>" / "»" so trailing section headers ("film fests / series :") drop off.
    const rawText = stripTags(chunk.split(/»|>>/)[0])
    // Shape: "thru M/D: <title> : <details>"
    const dm = /^thru\s+(\d{1,2}\/\d{1,2})\s*:\s*(.+)$/i.exec(rawText)
    if (!dm) continue
    const endDate = resolveEndDate(dm[1], todayNY)
    if (!endDate || !startUtc) continue
    const endUtc = nyToUtcISO(endDate, "23:59")
    if (!endUtc) continue
    // Skip anything that already ended.
    if (new Date(endUtc).getTime() < Date.now()) continue

    const rest = dm[2]
    // Title is the segment before the first " : " (spaces required, so internal colons
    // like "chabrol + huppert: doing wrong" stay in the title).
    const segs = rest.split(/\s+:\s+/)
    const title = (segs[0] || "").trim()
    const details = segs.slice(1).join(" : ").trim()
    if (!title) continue

    const { venue, neighborhood } = parseVenue(details || rest)
    const price = parsePrice(rawText)
    const haystack = `${title} ${details}`
    const category = inferCategory(haystack)
    // Address feeds the ingest geocoder; include neighborhood for better accuracy.
    const address = [venue, neighborhood].filter(Boolean).join(", ") || null

    out.push({
      id: deterministicId([SOURCE_NAME, url || title]),
      title,
      description: details || null,
      source: SOURCE_NAME,
      source_event_id: url || title,
      event_url: url,
      venue_name: venue,
      address,
      latitude: null,
      longitude: null,
      borough: null,
      neighborhood,
      category,
      tags: ["ongoing", "the skint"],
      organizer: null,
      start_time: startUtc, // ongoing: available now through the end date
      end_time: endUtc,
      price,
      currency: price && price !== "Free" && price !== "Various prices" ? "USD" : null,
      image_url: null,
    })
  }
  return out
}

export const theSkintSource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents() {
    const res = await fetch(PAGE_URL, {
      headers: { Accept: "text/html", "User-Agent": BROWSER_UA },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    return parseBullets(html, todayNY)
  },
}
