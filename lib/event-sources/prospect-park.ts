import { createTribeSource } from "./tribe"

// Prospect Park (Brooklyn) — art, food, wellness, nature, and family programming.
// Runs "The Events Calendar" (Tribe) plugin and exposes a rich, 1,000+ event JSON feed.
//
// The site sits behind a WAF that intermittently returns HTTP 403 to server-side requests
// after a few calls, regardless of User-Agent. To make this reliable from a serverless
// cron we enable `useProxyFallback`: each page is fetched directly first, and any failure
// is retried through the r.jina.ai reader proxy (which uses a real browser fingerprint).
export const prospectParkSource = createTribeSource({
  name: "Prospect Park",
  baseUrl: "https://www.prospectpark.org",
  enabled: true,
  useProxyFallback: true,
  organizer: "Prospect Park Alliance",
  defaultVenueName: "Prospect Park",
  defaultBorough: "Brooklyn",
  defaultLatitude: 40.6602,
  defaultLongitude: -73.969,
})
