import { createTribeSource } from "./tribe"

// Downtown Alliance (downtownny.com) — Lower Manhattan's BID, covering the Financial
// District & surrounding area. Runs "The Events Calendar" (Tribe) plugin, so it's a
// one-line config using the shared adapter.
//
// NOTE: as of integration the site's Tribe JSON API responds 200 but returns `total: 0`
// on every query — the org currently publishes its calendar without exposing events
// through the REST API (or has none in-window). We register it ENABLED anyway: it costs a
// single cheap request per run, yields nothing harmlessly today, and will begin producing
// events automatically if/when they populate the API. Coordinates fall back to Lower
// Manhattan for any venue-less entry.
export const downtownNySource = createTribeSource({
  name: "Downtown Alliance",
  baseUrl: "https://downtownny.com",
  enabled: true,
  organizer: "Alliance for Downtown New York",
  defaultVenueName: "Lower Manhattan",
  defaultBorough: "Manhattan",
  defaultLatitude: 40.7075,
  defaultLongitude: -74.0113,
})
