// A single event normalized to match the public.events table columns.
// Every event source (NYC Parks, future Luma/Meetup, etc.) returns this shape,
// so the ingest route can treat all sources identically.
export type NormalizedEvent = {
  id: string
  title: string
  description: string | null
  source: string
  source_event_id: string | null
  event_url: string | null
  venue_name: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  borough: string | null
  neighborhood: string | null
  category: string | null
  tags: string[] | null
  organizer: string | null
  start_time: string // UTC ISO timestamp
  end_time: string | null // UTC ISO timestamp
  price: string | null
  currency: string | null
  image_url: string | null
}

// Contract every event source implements. Add a new source by creating a file
// that exports one of these and registering it in lib/event-sources/index.ts.
export interface EventSource {
  // Human-readable name, also written to the events.source column.
  name: string
  // Flip to false to temporarily disable a source without removing it.
  enabled: boolean
  // Fetch upcoming events within the given horizon (in days from now, NYC time).
  fetchEvents(opts: { horizonDays: number }): Promise<NormalizedEvent[]>
}
