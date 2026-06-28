import { createTribeSource } from "./tribe"

// Prospect Park (Brooklyn) — art, food, wellness, nature, and family programming.
// Runs "The Events Calendar" (Tribe) plugin and exposes a rich, 1,000+ event JSON feed.
//
// DISABLED: the site sits behind a WAF (Cloudflare/Imperva-style) that intermittently
// returns HTTP 403 to server-side requests after a few calls, regardless of User-Agent.
// It works from a browser/residential IP but not reliably from a serverless cron, so we
// keep the config here (ready to flip on) but leave it out of every ingest run for now.
// Re-enable by setting `enabled: true` if their protection changes or we proxy requests.
export const prospectParkSource = createTribeSource({
  name: "Prospect Park",
  baseUrl: "https://www.prospectpark.org",
  enabled: false,
  organizer: "Prospect Park Alliance",
  defaultVenueName: "Prospect Park",
  defaultBorough: "Brooklyn",
  defaultLatitude: 40.6602,
  defaultLongitude: -73.969,
})
