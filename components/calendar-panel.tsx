"use client"

import { CalendarCheck, RefreshCw, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { type CalendarEvent } from "@/lib/types"

interface Props {
  configured: boolean
  connected: boolean
  loading: boolean
  googleEvents: CalendarEvent[]
  onRefresh: () => void
  onDisconnect: () => void
}

export function CalendarPanel({
  configured,
  connected,
  loading,
  googleEvents,
  onRefresh,
  onDisconnect,
}: Props) {
  return (
    <div className="flex flex-col gap-5">
      {/* Google connection */}
      <div className="rounded-lg border border-border bg-secondary/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CalendarCheck className="size-4 text-accent" />
            <div>
              <p className="text-sm font-medium leading-tight">Google Calendar</p>
              <p className="text-xs text-muted-foreground">
                {connected
                  ? `${googleEvents.length} event${googleEvents.length === 1 ? "" : "s"} this week`
                  : "Import your real schedule"}
              </p>
            </div>
          </div>
          {connected ? (
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh calendar">
                <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              </Button>
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              nativeButton={false}
              render={<a href="/api/google/auth" />}
              disabled={!configured}
            >
              <Link2 className="size-4" /> Connect
            </Button>
          )}
        </div>
        {!configured && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            To enable Google Calendar, add{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">GOOGLE_CLIENT_ID</code> and{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">GOOGLE_CLIENT_SECRET</code>{" "}
            in Project Settings.
          </p>
        )}
      </div>

      {/* Google event list */}
      {googleEvents.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {googleEvents.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary" className="shrink-0 font-normal">
                  {e.day.slice(0, 3)}
                </Badge>
                <span className="truncate">{e.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums text-muted-foreground">
                  {e.start}–{e.end}
                </span>
                <Badge variant="outline" className="font-normal text-accent">
                  Google
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
