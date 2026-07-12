"use client"

import { CalendarClock, CheckCircle2, MapPin, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { WORLD_CUP_MATCHES, type WorldCupMatch } from "@/lib/worldcup-schedule"

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
  const isCompleted = match.status === "completed"
  const [homeScore, awayScore] = match.score ?? [null, null]
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
          {isCompleted && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <CheckCircle2 className="size-3" /> Full time
            </span>
          )}
          {match.local && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
              <Star className="size-3" /> Local
            </span>
          )}
        </div>
        <p className="text-pretty text-sm font-semibold leading-snug">
          <span className={isCompleted && homeScore! > awayScore! ? "text-foreground" : ""}>{match.home}</span>
          {isCompleted && homeScore !== null ? (
            <span className="mx-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-foreground">
              {homeScore}–{awayScore}
            </span>
          ) : (
            <span className="text-muted-foreground"> vs </span>
          )}
          <span className={isCompleted && awayScore! > homeScore! ? "text-foreground" : ""}>{match.away}</span>
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
// Shows the full knockout stage from the quarter-finals on, with results for completed matches.
export function WorldCupSchedule() {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/40 p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-accent" />
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          2026 World Cup knockout schedule
        </h3>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Kickoff times shown in Eastern (New York) time. Quarter-final matchups are set — plan your viewing below.
      </p>
      <ul className="flex flex-col gap-2">
        {WORLD_CUP_MATCHES.map((m) => (
          <MatchRow key={m.id} match={m} />
        ))}
      </ul>
    </section>
  )
}
