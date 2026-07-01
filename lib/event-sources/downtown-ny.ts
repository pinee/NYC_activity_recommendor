import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, nyToUtcISO, nyMidnightToday, inferCategoryFromText } from "./util"

// Downtown Alliance (downtownny.com) — Lower Manhattan's BID (Financial District, Battery
// Park City, Seaport). It runs "The Events Calendar" (Tribe) plugin, but the site's Tribe
// JSON API responds 200 with `total: 0` on every query — the calendar is populated through
// a third-party events widget that never reaches the REST API. So instead of the Tribe
// adapter we render the public /calendar/ page through the free r.jina.ai reader proxy,
// which emits one markdown line per event, e.g.:
//
//   [Jul 1 st 6:14PM [See All Dates Weekly, each Wed](…) ![Image 24: Maestros…](img) #### Maestros & The Machines Mercer Labs * Music](https://downtownny.com/vm-event/maestros…_2026-07-01-18-14/)
//
// Parsing notes (why each choice is made):
//  - DATE comes from the visible prefix ("Jul 1"), NOT the slug's trailing datetime: for
//    recurring events the slug encodes the *series anchor* (often already past), while the
//    prefix is the actual next occurrence being displayed.
//  - The prefix has no YEAR, so we infer it (roll to next year only if the month already
//    passed), which is safe given the short ingest horizon.
//  - TIME comes from the prefix when shown; otherwise we fall back to the slug's embedded
//    "HH-MM"; otherwise noon.
//  - TITLE prefers the image ALT text (it preserves accents/punctuation) — but only when it
//    prefixes the heading, because ALT is occasionally a stale reused caption (a Smorgasburg
//    thumbnail on an "Oculus Outdoors" card). When it doesn't match we keep the heading text.
//  - CATEGORY reuses the shared inferCategoryFromText over the title + the site's own trailing
//    "* Music * Books" tags, so events route to real interests instead of "Others".
const SOURCE_NAME = "Downtown Alliance"
const LISTING_URL = "https://downtownny.com/calendar/"
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
// Lower Manhattan centroid — events are spread across the district, so one coordinate serves
// as an approximate fallback (approximate_location is always true for this source).
const LOWER_MANHATTAN = { lat: 40.7075, lng: -74.0113 }

const MONTHS3: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function clean(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

// The venue is the heading text left over after the title. The proxy sometimes appends the
// event's marketing blurb tail to it — typically a location/date phrase like
// "… in New York on June 27" or "… on Jul 1". Trim at those fragments so we keep just the
// venue name ("Le Poisson Rouge"), and drop it entirely if nothing sensible remains.
function cleanVenue(s: string): string | null {
  let v = s
    .replace(/\s+in\s+New York\b.*$/i, "")
    .replace(/\s+on\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b.*$/i, "")
    .replace(/[\s,]+$/, "")
    .trim()
  // Guard against over-trimming to an empty/too-short scrap.
  if (v.length < 2) return null
  return v
}

// "6:14PM" / "10AM" -> "HH:MM" 24-hour, or null.
function parseTime(token: string): string | null {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])\b/.exec(token)
  if (!m) return null
  let h = Number(m[1]) % 12
  if (/[Pp]/.test(m[3])) h += 12
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`
}

export const downtownNySource: EventSource = {
  name: SOURCE_NAME,
  enabled: true,
  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    const res = await fetch(`https://r.jina.ai/${LISTING_URL}`, { headers: { "User-Agent": BROWSER_UA } })
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`)
    const md = await res.text()

    const startDay = nyMidnightToday()
    const endDay = new Date(startDay.getTime() + horizonDays * 86400000)

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    for (const raw of md.split("\n")) {
      const line = raw.trim()
      // Only event rows: they carry a /vm-event/ link and a "#### <heading>".
      if (!line.includes("/vm-event/") || !line.includes("####")) continue

      const urlM = /\((https:\/\/downtownny\.com\/vm-event\/([^)\s"]+?))\/?\)/.exec(line)
      const headM = /####\s+(.+?)\]\(https:\/\/downtownny\.com\/vm-event\//.exec(line)
      if (!urlM || !headM) continue
      const eventUrl = `${urlM[1].replace(/\/$/, "")}/`
      const slug = urlM[2]
      if (seen.has(eventUrl)) continue

      // Prefix = text before the thumbnail/heading, with any nested "[See All Dates …]"
      // recurrence link stripped so its own dates/times can't shadow the real ones.
      const prefix = line
        .split("![Image")[0]
        .split("####")[0]
        .replace(/\[See All Dates[^\]]*\]\([^)]*\)/g, " ")

      // Visible date: leading "Mon D" (ordinal suffix optional). Anchored so ranges like
      // "Jul 1 – 2" yield the start day.
      const dateM = /^\[\s*([A-Za-z]{3})[a-z]*\s+(\d{1,2})/.exec(prefix)
      if (!dateM) continue
      const mo = MONTHS3[dateM[1].toLowerCase()]
      if (mo === undefined) continue
      const day = Number(dateM[2])
      if (day < 1 || day > 31) continue

      // Infer the year: use the current year, rolling forward only if that month is already
      // well behind us (guards the Dec -> Jan boundary without mis-dating near-term events).
      let year = startDay.getFullYear()
      if (new Date(year, mo, day).getTime() < startDay.getTime() - 60 * 86400000) year += 1
      const dateISO = `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`

      // Time: prefix first, else the slug's embedded "…_YYYY-MM-DD-HH-MM", else noon.
      let time = parseTime(prefix)
      if (!time) {
        const slugTime = /_\d{4}-\d{2}-\d{2}-(\d{2})-(\d{2})\/?$/.exec(slug)
        if (slugTime) time = `${slugTime[1]}:${slugTime[2]}`
      }
      const startUtc = nyToUtcISO(dateISO, time || "12:00")
      if (!startUtc) continue

      const d = new Date(`${dateISO}T12:00:00`)
      if (d < startDay || d > endDay) continue

      // Heading = "Title [Venue] * cat * cat". Split off the site's category tags first.
      const headParts = clean(headM[1]).split(/\s*\*\s*/)
      const titleVenue = headParts[0]
      const siteCategories = headParts.slice(1).map((c) => c.trim()).filter(Boolean)

      // ALT text is the cleanest title WHEN it prefixes the heading; otherwise it's a stale
      // reused thumbnail caption and we fall back to the heading text.
      const altM = /!\[Image\s+\d+:\s*([^\]]+)\]/.exec(line)
      const alt = altM ? clean(altM[1]) : ""
      let title = titleVenue
      let venue: string | null = null
      if (alt && titleVenue.toLowerCase().startsWith(alt.toLowerCase())) {
        title = alt
        venue = cleanVenue(clean(titleVenue.slice(alt.length)))
      }
      if (!title) continue

      // Only keep a real https thumbnail (some entries carry a "blob:" placeholder).
      const imgM = /!\[Image\s+\d+:[^\]]*\]\((https:\/\/downtownny\.com\/[^)]+)\)/.exec(line)
      const imageUrl = imgM ? imgM[1] : null

      const category = inferCategoryFromText(title, siteCategories.join(" ")) || "Others"
      const isFree = siteCategories.some((c) => /^free$/i.test(c))

      seen.add(eventUrl)
      out.push({
        id: deterministicId([SOURCE_NAME, eventUrl]),
        title,
        description: null,
        source: SOURCE_NAME,
        source_event_id: eventUrl,
        event_url: eventUrl,
        venue_name: venue || "Lower Manhattan",
        address: null,
        latitude: LOWER_MANHATTAN.lat,
        longitude: LOWER_MANHATTAN.lng,
        borough: "Manhattan",
        neighborhood: "Lower Manhattan",
        category,
        tags: ["downtown alliance", ...siteCategories.map((c) => c.toLowerCase())],
        organizer: "Alliance for Downtown New York",
        start_time: startUtc,
        end_time: null,
        price: isFree ? "Free" : null,
        currency: "USD",
        image_url: imageUrl,
        // District-wide fallback coordinate, not the specific venue.
        approximate_location: true,
      })
    }
    return out
  },
}
