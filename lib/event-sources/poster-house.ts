import { createTribeSource } from "./tribe"

// Poster House (posterhouse.org) — NYC's museum dedicated to poster art & design, in
// Chelsea. Runs "The Events Calendar" (Tribe) plugin with a clean, key-less JSON API
// (~70 upcoming events: exhibition tours, talks, workshops, family programs).
//
// It's a single-venue institution, so we supply the museum's coordinates as a fallback
// for any event whose feed entry omits venue geo, keeping travel-time filtering accurate.
// Its own category text (e.g. "Programs") lacks our interest keywords for most talks/tours,
// so we leave the site categories in `tags` and let the plan route's keyword matching work
// off the real category when present.
export const posterHouseSource = createTribeSource({
  name: "Poster House",
  baseUrl: "https://posterhouse.org",
  enabled: true,
  organizer: "Poster House",
  defaultVenueName: "Poster House",
  defaultBorough: "Manhattan",
  defaultLatitude: 40.744,
  defaultLongitude: -73.993,
})
