import type { EventSource } from "./types"
import { nycParksSource } from "./nyc-parks"

// Registry of all event sources the ingest job pulls from.
// To add a new free feed or official API later (e.g. Luma, Meetup), implement the
// EventSource interface in its own file and add it to this array.
export const eventSources: EventSource[] = [nycParksSource]

export type { EventSource, NormalizedEvent } from "./types"
