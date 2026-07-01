import { createTribeSource } from "./tribe"

// Flatiron NoMad (flatironnomad.nyc) — the Flatiron/NoMad business improvement district's
// public programming: plaza fitness, art installations, food events, walking tours, and
// holiday activations. Runs "The Events Calendar" (Tribe) plugin with a clean JSON API.
//
// Events are spread across the district's plazas rather than one venue, so we fall back to
// the Flatiron Building's coordinates when an entry lacks venue geo (marked approximate by
// the adapter), keeping travel-time filtering sane for a small, compact neighborhood.
//
// The site tags everything "Culture"/"Entertainment" (format, not topic), which matches no
// interest — so we infer each event's category from its title (jazz night → Live music,
// bookstore talk → Books & readings, youth musical → Theater). Anything inconclusive keeps
// the site category and is reachable via the "Others" interest. Originals stay in `tags`.
export const flatironNomadSource = createTribeSource({
  name: "Flatiron NoMad",
  baseUrl: "https://flatironnomad.nyc",
  enabled: true,
  organizer: "Flatiron NoMad Partnership",
  inferCategory: true,
  defaultVenueName: "Flatiron Plazas",
  defaultBorough: "Manhattan",
  defaultLatitude: 40.7411,
  defaultLongitude: -73.9897,
})
