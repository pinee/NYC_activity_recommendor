"use client"

import { useState } from "react"
import { CalendarCheck, Plus, X, RefreshCw, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { WEEK_DAYS, type CalendarEvent, type WeekDay } from "@/lib/types"

interface Props {
  configured: boolean
  connected: boolean
  loading: boolean
  googleEvents: CalendarEvent[]
  manualEvents: CalendarEvent[]
  onRefresh: () => void
  onDisconnect: () => void
  onAddManual: (e: CalendarEvent) => void
  onRemoveManual: (id: string) => void
}

export function CalendarPanel({
  configured,
  connected,
  loading,
  googleEvents,
  manualEvents,
  onRefresh,
  onDisconnect,
  onAddManual,
  onRemoveManual,
}: Props) {
  const [title, setTitle] = useState("")
  const [day, setDay] = useState<WeekDay>("Thursday")
  const [start, setStart] = useState("18:00")
  const [end, setEnd] = useState("20:00")

  const addManual = () => {
    onAddManual({
      id: `manual-${Date.now()}`,
      title: title.trim() || "Busy",
      day,
      start,
      end,
      source: "manual",
    })
    setTitle("")
  }

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
            in Project Settings. You can also just add busy times manually below.
          </p>
        )}
      </div>

      {/* Combined event list */}
      {(googleEvents.length > 0 || manualEvents.length > 0) && (
        <ul className="flex flex-col gap-1.5">
          {[...googleEvents, ...manualEvents].map((e) => (
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
                {e.source === "manual" ? (
                  <button
                    type="button"
                    onClick={() => onRemoveManual(e.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove busy block"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : (
                  <Badge variant="outline" className="font-normal text-accent">
                    Google
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add manual busy block */}
      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Add a busy block</p>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="What is it? e.g. Dinner with Sam"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={day} onValueChange={(v) => setDay(v as WeekDay)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEK_DAYS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="time"
              aria-label="Busy start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-28"
            />
            <Input
              type="time"
              aria-label="Busy end"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-28"
            />
            <Button variant="secondary" size="icon" onClick={addManual} aria-label="Add busy block">
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
