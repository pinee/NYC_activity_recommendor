import type { EventSource } from "./types"
import { nycParksSource } from "./nyc-parks"
import { summerStageSource } from "./summerstage"
import { prospectParkSource } from "./prospect-park"
import { greenWoodSource } from "./green-wood"

// Registry of all event sources the ingest job pulls from.
// To add a new free feed or official API later (e.g. Luma, Meetup), implement the
// EventSource interface in its own file and add it to this array. Sites running
// "The Events Calendar" (Tribe) plugin can reuse createTribeSource (see summerstage.ts).
export const eventSources: EventSource[] = [
  nycParksSource,
  summerStageSource,
  prospectParkSource,
  greenWoodSource,
]

export type { EventSource, NormalizedEvent } from "./types"
