// Shared link-quality helpers used by both the daily ingestion job and the plan route.
// These encode hard-won rules: never link to a wrong-city page, prefer specific event
// pages over generic listings, and verify links are actually reachable.

// Returns a clean http(s) URL, prepending https:// to bare domains; null if not a real URL.
export function normalizeSourceUrl(url: string | undefined | null): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (!/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return null
  return `https://${trimmed}`
}

export function tokenize(s: string): string[] {
  return (s || "").toLowerCase().match(/[a-z0-9]+/g) || []
}

// Generic / location / temporal words that are useless for matching an event to its link.
export const GENERIC_TOKENS = new Set([
  "new",
  "york",
  "nyc",
  "city",
  "the",
  "and",
  "for",
  "with",
  "events",
  "event",
  "calendar",
  "guide",
  "best",
  "top",
  "things",
  "todo",
  "do",
  "weekend",
  "week",
  "today",
  "tonight",
  "festival",
  "fair",
  "grand",
  "tasting",
  "show",
  "live",
  "free",
  "tickets",
  "ticket",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "2025",
  "2026",
])

// NYC-related path segments that legitimately appear in real NYC event URLs.
export const NYC_GEO_TOKENS = ["new-york", "newyork", "nyc", "manhattan", "brooklyn", "queens", "bronx", "staten"]

// Pages clearly scoped to a non-NYC city (e.g. timeout.com/chicago/...). These must
// NEVER be linked — this is what caused a Chicago events page to appear for an NYC event.
export function isWrongCityUrl(url: string): boolean {
  let pathname = ""
  let full = ""
  try {
    const u = new URL(url)
    pathname = u.pathname.toLowerCase()
    full = `${u.hostname}${u.pathname}`.toLowerCase()
  } catch {
    return true
  }
  const otherCities = [
    "chicago",
    "los-angeles",
    "san-francisco",
    "boston",
    "miami",
    "london",
    "paris",
    "seattle",
    "austin",
    "dallas",
    "houston",
    "atlanta",
    "philadelphia",
    "washington",
    "denver",
    "toronto",
    "vegas",
    "orlando",
    "nashville",
    "portland",
  ]
  const segments = pathname.split("/").filter(Boolean)
  const mentionsNyc = NYC_GEO_TOKENS.some((g) => full.includes(g))
  return segments.some((seg) => otherCities.includes(seg)) && !mentionsNyc
}

// Generic "what's on / things to do / events calendar / month" listing pages. These are
// real and the right city, but not a specific event page — usable only as a last-resort link.
export function isGenericListingUrl(url: string): boolean {
  let pathname = ""
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    return true
  }
  const aggregatorPatterns = [
    "events-calendar",
    "event-calendar",
    "things-to-do",
    "what-to-do",
    "whats-on",
    "what-to-do-in",
    "this-weekend",
    "best-",
    "-guide",
    "/guide",
    "top-things",
    "/calendar",
    "/events/month",
    "/free-events",
  ]
  if (aggregatorPatterns.some((p) => pathname.includes(p))) return true
  // Eventbrite/Meetup broad discovery listings like /d/ny--new-york/...
  if (/\/d\/[^/]+\/\d{4}/.test(pathname)) return true
  return false
}

// Verify a link is actually live and bookable. Returns true only if the page can be
// reached and does not return a "not found" / "gone" status. We deliberately KEEP
// links that respond with bot-blocking codes (401/403/405/429) since those pages are
// real and load fine in a browser, and only DROP true failures: network/DNS errors
// ("site cannot be reached"), 404, 410, and server errors.
export async function isUrlReachable(url: string): Promise<boolean> {
  const fetchWithTimeout = async (method: "HEAD" | "GET") => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 7000)
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Browser-like UA so sites don't reject us outright
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  const deadStatuses = new Set([404, 410, 500, 502, 503, 504])
  try {
    let res = await fetchWithTimeout("HEAD")
    // Many servers don't support HEAD — retry with GET before judging.
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout("GET")
    }
    return !deadStatuses.has(res.status)
  } catch {
    // Network failure, DNS error, timeout → "site cannot be reached"
    return false
  }
}

// Find the citation whose title/URL best overlaps the activity's venue + title.
// Returns a real listing URL (never a search page) or null if nothing plausibly matches.
export function bestCitationFor(
  activity: { venue?: string; title?: string },
  citations: { title: string; url: string }[],
): string | null {
  // Only DISTINCTIVE words count — generic/location/temporal words cause false matches
  // to aggregator pages (e.g. "city"/"festival"/"june" matching a Chicago events calendar).
  const targetTokens = new Set(
    [...tokenize(activity.venue || ""), ...tokenize(activity.title || "")].filter(
      (t) => t.length >= 4 && !GENERIC_TOKENS.has(t),
    ),
  )
  if (targetTokens.size === 0) return null

  // Prefer specific event/venue pages; allow a NYC listing page only as a fallback.
  let bestSpecific: { url: string; score: number } | null = null
  let bestListing: { url: string; score: number } | null = null
  for (const c of citations) {
    // Never link to a wrong-city page — that is the bug we are fixing.
    if (isWrongCityUrl(c.url)) continue
    const haystack = `${c.title} ${c.url}`.toLowerCase()
    let score = 0
    for (const t of targetTokens) {
      if (haystack.includes(t)) score++
    }
    if (isGenericListingUrl(c.url)) {
      if (!bestListing || score > bestListing.score) bestListing = { url: c.url, score }
    } else {
      if (!bestSpecific || score > bestSpecific.score) bestSpecific = { url: c.url, score }
    }
  }
  // A specific page needs 2 distinctive matches; a generic NYC listing is a weaker
  // fallback (needs 1) so the user still has somewhere real to go.
  if (bestSpecific && bestSpecific.score >= 2) return bestSpecific.url
  if (bestListing && bestListing.score >= 1) return bestListing.url
  return null
}

// Build a de-duplicated list of {title, url, host} sources from raw citations.
export function dedupeSources(citations: { title: string; url: string }[]) {
  return Array.from(
    new Map(
      citations.map((c) => {
        let host = ""
        try {
          host = new URL(c.url).hostname.replace(/^www\./, "")
        } catch {
          host = c.url
        }
        return [host, { title: c.title || host, url: c.url, host }]
      }),
    ).values(),
  )
}
