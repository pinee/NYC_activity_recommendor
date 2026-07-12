// Static schedule of the 2026 FIFA World Cup knockout stage from the quarter-finals onward,
// with kickoff times shown in New York (Eastern) time. Kickoff times are stored as ISO strings
// with an explicit Eastern offset (-04:00, EDT) so they render consistently regardless of the
// viewer's own timezone.
//
// The quarter-final matchups are now decided, so actual teams (and results for completed
// matches) are listed. Later-round opponents that depend on unfinished matches use
// bracket-position labels (e.g. "Winner QF3") until they are confirmed.

export interface WorldCupMatch {
  id: string
  round: string
  home: string
  away: string
  kickoff: string // ISO with -04:00 (Eastern Daylight) offset
  venue: string
  city: string
  status: "completed" | "scheduled"
  // Final score for completed matches, home-away (e.g. [2, 0]).
  score?: [number, number]
  // Highlight matches hosted in the NY/NJ metro area (MetLife Stadium) — the local final.
  local: boolean
}

export const WORLD_CUP_MATCHES: WorldCupMatch[] = [
  {
    id: "qf1",
    round: "Quarter-final",
    home: "France",
    away: "Morocco",
    kickoff: "2026-07-09T15:00:00-04:00",
    venue: "Gillette Stadium",
    city: "Boston (Foxborough)",
    status: "completed",
    score: [2, 0],
    local: false,
  },
  {
    id: "qf2",
    round: "Quarter-final",
    home: "Spain",
    away: "Belgium",
    kickoff: "2026-07-10T15:00:00-04:00",
    venue: "SoFi Stadium",
    city: "Los Angeles",
    status: "completed",
    score: [2, 1],
    local: false,
  },
  {
    id: "qf3",
    round: "Quarter-final",
    home: "Norway",
    away: "England",
    kickoff: "2026-07-11T17:00:00-04:00",
    venue: "Hard Rock Stadium",
    city: "Miami",
    status: "scheduled",
    local: false,
  },
  {
    id: "qf4",
    round: "Quarter-final",
    home: "Argentina",
    away: "Switzerland",
    kickoff: "2026-07-11T21:00:00-04:00",
    venue: "Arrowhead Stadium",
    city: "Kansas City",
    status: "scheduled",
    local: false,
  },
  {
    id: "sf1",
    round: "Semi-final",
    home: "France",
    away: "Spain",
    kickoff: "2026-07-14T15:00:00-04:00",
    venue: "AT&T Stadium",
    city: "Dallas",
    status: "scheduled",
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
    status: "scheduled",
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
    status: "scheduled",
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
    status: "scheduled",
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
