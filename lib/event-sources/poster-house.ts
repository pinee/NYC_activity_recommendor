import { createTribeSource } from "./tribe"

// Poster House (posterhouse.org) — NYC's museum dedicated to poster art & design, in
// Chelsea. Runs "The Events Calendar" (Tribe) plugin with a clean, key-less JSON API
// (~70 upcoming events: exhibition tours, talks, workshops, family programs).
//
// It's a single-venue institution, so we supply the museum's coordinates as a fallback
// for any event whose feed entry omits venue geo, keeping travel-time filtering accurate.
//
// Its site categories only describe format ("In-Person"/"Virtual"), which match no interest.
// The programming itself is varied — curatorial tours, workshops, jazz performances, family
// events — so we infer each event's category from its title, and fall back to "Museums" when
// inference is inconclusive (accurate, since every event is a museum program). Site
// categories are still preserved in `tags`.
export const posterHouseSource = createTribeSource({
  name: "Poster House",
  baseUrl: "https://posterhouse.org",
  enabled: true,
  organizer: "Poster House",
  inferCategory: true,
  categoryOverride: "Museums",
  defaultVenueName: "Poster House",
  defaultBorough: "Manhattan",
  defaultLatitude: 40.744,
  defaultLongitude: -73.993,
})
