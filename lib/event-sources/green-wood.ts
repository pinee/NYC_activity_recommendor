import { createTribeSource } from "./tribe"

// Green-Wood Cemetery (Brooklyn) — walking tours, birding, history talks, and
// cultural programming in the historic landmark cemetery. Runs "The Events Calendar"
// (Tribe) plugin. Events lack venue coordinates, so we pin them to Green-Wood's main
// entrance (25th St & 5th Ave) so the deterministic travel-time filter still applies.
export const greenWoodSource = createTribeSource({
  name: "Green-Wood Cemetery",
  baseUrl: "https://www.green-wood.com",
  organizer: "The Green-Wood Cemetery",
  defaultVenueName: "Green-Wood Cemetery",
  defaultBorough: "Brooklyn",
  defaultLatitude: 40.6579,
  defaultLongitude: -73.994,
})
