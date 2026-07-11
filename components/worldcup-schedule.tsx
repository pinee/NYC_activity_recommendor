"use client"

import { CalendarClock, MapPin, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { WORLD_CUP_MATCHES, upcomingMatches, type WorldCupMatch } from "@/lib/worldcup-schedule"

// Format the kickoff for a NYC audience: weekday, date, and time in Eastern.
function formatKickoff(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  const day = d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  })
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
  return { day, time }
}

function MatchRow({ match }: { match: WorldCupMatch }) {
  const { day, time } = formatKickoff(match.kickoff)
  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
        match.local ? "border-accent/40 bg-accent/5" : "border-border bg-card"
      }`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wider">
            {match.round}
          </Badge>
          {match.local && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
              <Star className="size-3" /> Local
            </span>
          )}
        </div>
        <p className="text-pretty text-sm font-semibold leading-snug">
          {match.home} <span className="text-muted-foreground">vs</span> {match.away}
        </p>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3 shrink-0" />
          {match.venue}, {match.city}
        </span>
      </div>
      <div className="flex shrink-0 flex-col sm:items-end">
        <span className="text-sm font-semibold tabular-nums text-foreground">{time}</span>
        <span className="text-xs text-muted-foreground">{day}</span>
      </div>
    </li>
  )
}

// Match-times schedule shown at the top of the "Browse all World Cup viewing" section.
// Prefers upcoming fixtures; falls back to the full list once the tournament is over.
export function WorldCupSchedule() {
  const upcoming = upcomingMatches()
  const matches = upcoming.length > 0 ? upcoming : WORLD_CUP_MATCHES

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/40 p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-accent" />
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {upcoming.length > 0 ? "Upcoming match times" : "Match schedule"}
        </h3>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Kickoff times shown in Eastern (New York) time. Plan your viewing around the fixtures below.
      </p>
      <ul className="flex flex-col gap-2">
        {matches.map((m) => (
          <MatchRow key={m.id} match={m} />
        ))}
      </ul>
    </section>
  )
}
