import type { EventSource, NormalizedEvent } from "./types"

// New York Public Library events calendar (nypl.org/events/calendar).
//
// DISABLED — no reliable server-fetchable data route:
//   • The official JSON endpoint (/events/calendar/api/search) is behind Akamai bot
//     management: every server-side request (any headers, direct or via the r.jina.ai
//     proxy) returns a "ROBOTS NOINDEX/NOFOLLOW" interstitial instead of JSON.
//   • The human calendar page is a client-rendered SPA. Rendering it through the reader
//     proxy DOES surface events, but the output is unsafe to ingest: start times are
//     corrupted (morning storytimes render as "@ 11 PM"), and events have no clean titles
//     (the text after the time is a program-series label or the description itself, with no
//     consistent event name or detail URL).
//
// Ingesting that would place events at wrong times under wrong titles, which is worse than
// omitting the source. Left here (enabled: false) as a documented stub — revisit if NYPL
// exposes an official feed/API or relaxes bot protection.
const SOURCE_NAME = "NYPL"

export const nyplSource: EventSource = {
  name: SOURCE_NAME,
  enabled: false,
  async fetchEvents(): Promise<NormalizedEvent[]> {
    return []
  },
}
