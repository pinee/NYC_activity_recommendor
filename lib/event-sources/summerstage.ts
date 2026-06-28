import { createTribeSource } from "./tribe"

// SummerStage — City Parks Foundation's free outdoor concert series across NYC parks.
// Runs on "The Events Calendar" (Tribe) WordPress plugin, so we use the generic adapter.
// We filter to the "summerstage" category and label these as Live Music so they match
// the user's "Live music" interest (the site's own category text wouldn't).
export const summerStageSource = createTribeSource({
  name: "SummerStage",
  baseUrl: "https://cityparksfoundation.org",
  categorySlug: "summerstage",
  organizer: "City Parks Foundation",
  categoryOverride: "Live Music",
})
