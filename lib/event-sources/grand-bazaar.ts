import type { EventSource, NormalizedEvent } from "./types"
import { deterministicId, monthDayToNyDate, nyMidnightToday, nyToUtcISO, parseClockTo24h } from "./util"

// Grand Bazaar NYC (grandbazaarnyc.org/events) — NYC's oldest curated weekend market of
// independent makers, artists, and vintage dealers (its proceeds fund four local public
// schools). Its main market runs on the Upper West Side; some special editions pop up
// elsewhere (e.g. Industry City in Brooklyn).
//
// The events page is server-rendered WordPress HTML. Each event is:
//   <article class="row news-full">
//     <a href="…/events/<slug>/"><img src alt="Title"></a>
//     <span class="date-second text-uppercase">12 July</span>   (day + month, no year)
//     <small> 10:00 AM - 5:00 PM</small>
//     <h3>Title</h3>
//     <p>Description […]</p>
//   </article>
//
// Dates are year-less, so we infer the year relative to today (shared monthDayToNyDate). All
// events are markets → "Markets & shopping". Locations aren't published per-event, so we use a
// generic venue and mark the location approximate (detecting the Industry City / Brooklyn
// editions from the title so their borough is right).

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const URL = "https://grandbazaarnyc.org/events/"

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8211;/g, "–")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function firstMatch(block: string, re: RegExp): string | null {
  const m = re.exec(block)
  return m ? decodeEntities(m[1]) : null
}

export const grandBazaarSource: EventSource = {
  name: "Grand Bazaar NYC",
  enabled: true,

  async fetchEvents({ horizonDays }): Promise<NormalizedEvent[]> {
    let html: string
    try {
      const res = await fetch(URL, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } })
      if (!res.ok) return []
      html = await res.text()
    } catch {
      return []
    }

    const todayNY = nyMidnightToday()
    const startWindow = todayNY.getTime()
    const endWindow = startWindow + horizonDays * 86400000

    const out: NormalizedEvent[] = []
    const seen = new Set<string>()

    for (const art of html.matchAll(/<article class="row news-full">([\s\S]*?)<\/article>/gi)) {
      const block = art[1]

      const title = firstMatch(block, /<h3[^>]*>([\s\S]*?)<\/h3>/i)
      if (!title) continue

      // "12 July" -> day + month (day precedes month here).
      const dateText = firstMatch(block, /class="date-second[^"]*">([^<]*)</i)
      const dm = dateText ? /(\d{1,2})\s+([A-Za-z]+)/.exec(dateText) : null
      if (!dm) continue
      const startDate = monthDayToNyDate(dm[2], Number(dm[1]), todayNY)
      if (!startDate) continue

      const timeText = firstMatch(block, /<small>([^<]*)<\/small>/i)
      const time = (timeText ? parseClockTo24h(timeText.split(/[-–—]/)[0]) : "") || "00:00"

      const startISO = nyToUtcISO(startDate, time)
      if (!startISO) continue
      const startMs = new Date(startISO).getTime()
      if (startMs < startWindow || startMs > endWindow) continue

      if (seen.has(startISO + title)) continue
      seen.add(startISO + title)

      const href = firstMatch(block, /href="(https?:\/\/grandbazaarnyc\.org\/events?\/[^"#?]+)"/i)
      const image = firstMatch(block, /<img[^>]*\ssrc="(https?:\/\/[^"]+)"/i)
      const description = firstMatch(block, /<p[^>]*>([\s\S]*?)<\/p>/i)

      // The main market is on the Upper West Side (Manhattan); "Industry City" editions are in
      // Brooklyn. Detect that from the title so at least the borough is correct.
      const isIndustryCity = /industry city/i.test(title)
      const venueName = isIndustryCity ? "Industry City" : "Grand Bazaar NYC"
      const address = isIndustryCity ? "Industry City, Brooklyn, NY" : "100 W 77th St, New York, NY 10024"
      const borough = isIndustryCity ? "Brooklyn" : "Manhattan"

      out.push({
        id: deterministicId(["Grand Bazaar NYC", title, startDate]),
        title,
        description,
        source: "Grand Bazaar NYC",
        source_event_id: null,
        event_url: href || URL,
        venue_name: venueName,
        address,
        latitude: null,
        longitude: null,
        borough,
        neighborhood: null,
        category: "Markets & shopping",
        tags: ["Markets & shopping", "Grand Bazaar NYC"],
        organizer: "Grand Bazaar NYC",
        start_time: startISO,
        end_time: null,
        price: "Free",
        currency: "USD",
        image_url: image,
        // Per-event coordinates aren't published; we use a known venue address but keep this
        // approximate since some editions pop up at other locations.
        approximate_location: true,
      })
    }

    return out
  },
}
