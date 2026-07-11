// Static schedule of remaining 2026 FIFA World Cup matches, with kickoff times shown in
// New York (Eastern) time. The tournament runs June 11 – July 19, 2026; this list covers the
// knockout rounds so NYC fans know exactly when to be in front of a screen. Kickoff times are
// stored as ISO strings with an explicit -04:00 (EDT) offset so they render consistently
// regardless of the viewer's own timezone.
//
// Team matchups for the knockout bracket are not fixed until each prior round finishes, so we
// use bracket-position labels (e.g. "Winner QF1") rather than inventing results.

export interface WorldCupMatch {
  id: string
  round: string
  home: string
  away: string
  kickoff: string // ISO with -04:00 (Eastern Daylight) offset
  venue: string
  city: string
  // Highlight matches hosted in the NY/NJ metro area (MetLife Stadium) — the local final.
  local: boolean
}

export const WORLD_CUP_MATCHES: WorldCupMatch[] = [
  {
    id: "qf1",
    round: "Quarter-final",
    home: "Winner R16-1",
    away: "Winner R16-2",
    kickoff: "2026-07-09T18:00:00-04:00",
    venue: "SoFi Stadium",
    city: "Los Angeles",
    local: false,
  },
  {
    id: "qf2",
    round: "Quarter-final",
    home: "Winner R16-3",
    away: "Winner R16-4",
    kickoff: "2026-07-10T18:00:00-04:00",
    venue: "Arrowhead Stadium",
    city: "Kansas City",
    local: false,
  },
  {
    id: "qf3",
    round: "Quarter-final",
    home: "Winner R16-5",
    away: "Winner R16-6",
    kickoff: "2026-07-11T12:00:00-04:00",
    venue: "Hard Rock Stadium",
    city: "Miami",
    local: false,
  },
  {
    id: "qf4",
    round: "Quarter-final",
    home: "Winner R16-7",
    away: "Winner R16-8",
    kickoff: "2026-07-11T16:00:00-04:00",
    venue: "Gillette Stadium",
    city: "Boston",
    local: false,
  },
  {
    id: "sf1",
    round: "Semi-final",
    home: "Winner QF1",
    away: "Winner QF2",
    kickoff: "2026-07-14T15:00:00-04:00",
    venue: "AT&T Stadium",
    city: "Dallas",
    local: false,
  },
  {
    id: "sf2",
    round: "Semi-final",
    home: "Winner QF3",
    away: "Winner QF4",
    kickoff: "2026-07-15T15:00:00-04:00",
    venue: "Mercedes-Benz Stadium",
    city: "Atlanta",
    local: false,
  },
  {
    id: "third",
    round: "Third-place play-off",
    home: "Loser SF1",
    away: "Loser SF2",
    kickoff: "2026-07-18T15:00:00-04:00",
    venue: "Hard Rock Stadium",
    city: "Miami",
    local: false,
  },
  {
    id: "final",
    round: "Final",
    home: "Winner SF1",
    away: "Winner SF2",
    kickoff: "2026-07-19T15:00:00-04:00",
    venue: "MetLife Stadium",
    city: "New York / New Jersey",
    local: true,
  },
]

// Return matches that haven't kicked off yet (relative to `now`), soonest first.
export function upcomingMatches(now: Date = new Date()): WorldCupMatch[] {
  const t = now.getTime()
  return WORLD_CUP_MATCHES.filter((m) => new Date(m.kickoff).getTime() >= t).sort(
    (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
  )
}
