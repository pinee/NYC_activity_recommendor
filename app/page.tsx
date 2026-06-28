"use client"

import { useCallback, useEffect, useState } from "react"
import { Sparkles, Loader2, CalendarRange, MapPinned, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ProfileForm } from "@/components/profile-form"
import { CalendarPanel } from "@/components/calendar-panel"
import { WeatherStrip } from "@/components/weather-strip"
import { SpecialRequests } from "@/components/special-requests"
import { WeeklyPlanView } from "@/components/weekly-plan"
import { useLocalStorage } from "@/lib/use-local-storage"
import {
  DEFAULT_PROFILE,
  type CalendarEvent,
  type Profile,
  type SpecialRequest,
  type WeatherDay,
  type WeeklyPlan,
} from "@/lib/types"

export default function Page() {
  const [profile, setProfile] = useLocalStorage<Profile>("nyc.profile", DEFAULT_PROFILE)
  const [manualEvents, setManualEvents] = useLocalStorage<CalendarEvent[]>("nyc.manualEvents", [])
  const [requests, setRequests] = useLocalStorage<SpecialRequest[]>("nyc.requests", [])

  const [weather, setWeather] = useState<WeatherDay[]>([])
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [cal, setCal] = useState({ configured: false, connected: false })
  const [calLoading, setCalLoading] = useState(false)

  const [plan, setPlan] = useState<WeeklyPlan | null>(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState("")

  const loadCalendar = useCallback(async () => {
    setCalLoading(true)
    try {
      const res = await fetch("/api/google/events")
      const data = await res.json()
      setCal({ configured: data.configured, connected: data.connected })
      setGoogleEvents(data.events ?? [])
    } catch {
      // ignore
    } finally {
      setCalLoading(false)
    }
  }, [])

  // Initial loads
  useEffect(() => {
    fetch("/api/weather")
      .then((r) => r.json())
      .then((d) => setWeather(d.days ?? []))
      .catch(() => {})
    loadCalendar()
  }, [loadCalendar])

  // Handle OAuth redirect feedback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("gcal")
    if (!status) return
    if (status === "connected") toast.success("Google Calendar connected")
    else if (status === "unconfigured")
      toast.error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Project Settings first")
    else if (status) toast.error("Could not connect Google Calendar. Please try again.")
    window.history.replaceState({}, "", "/")
  }, [])

  const disconnect = async () => {
    await fetch("/api/google/disconnect", { method: "POST" })
    setCal((c) => ({ ...c, connected: false }))
    setGoogleEvents([])
    toast.success("Disconnected Google Calendar")
  }

  const generate = async () => {
    if (profile.interests.length === 0) {
      toast.error("Pick at least one interest first")
      return
    }
    setGenerating(true)
    setPlan(null)
    setProgress("Starting…")
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          weather,
          events: [...googleEvents, ...manualEvents],
          requests,
        }),
      })

      if (!res.body) throw new Error("No stream")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let done = false

      while (!done) {
        const { value, done: streamDone } = await reader.read()
        done = streamDone
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const msg = JSON.parse(trimmed)
          if (msg.type === "status") {
            setProgress(msg.message)
          } else if (msg.type === "error") {
            toast.error(msg.error || "Could not build your plan. Please try again.", {
              duration: msg.code === "billing" || msg.code === "rate_limit" ? 12000 : 5000,
            })
          } else if (msg.type === "result") {
            const activities = msg.activities ?? []
            setPlan({ summary: msg.summary, activities, sources: msg.sources ?? [] })
            if (activities.length === 0) {
              toast("No activities matched your interests this week")
            } else {
              toast.success(
                `${msg.cached ? "Loaded" : "Found"} ${activities.length} activities for your week`,
              )
            }
          }
        }
      }
    } catch {
      toast.error("Could not build your plan. Please try again.")
    } finally {
      setGenerating(false)
      setProgress("")
    }
  }

  return (
    <div className="min-h-svh">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-background">
              <MapPinned className="size-4" />
            </div>
            <div className="leading-tight">
              <p className="font-mono text-sm font-bold uppercase tracking-widest">NYC Activities</p>
              <p className="text-xs text-muted-foreground">Your weekly concierge</p>
            </div>
          </div>
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <Sparkles className="size-3.5 text-accent" /> Live web-sourced recommendations
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,400px)_1fr]">
        {/* Inputs column */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                <MapPinned className="size-4 text-accent" /> Your profile
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ProfileForm profile={profile} onChange={setProfile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                <CalendarRange className="size-4 text-accent" /> Calendar
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CalendarPanel
                configured={cal.configured}
                connected={cal.connected}
                loading={calLoading}
                googleEvents={googleEvents}
                manualEvents={manualEvents}
                onRefresh={loadCalendar}
                onDisconnect={disconnect}
                onAddManual={(e) => setManualEvents((prev) => [...prev, e])}
                onRemoveManual={(id) => setManualEvents((prev) => prev.filter((m) => m.id !== id))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                <Sparkles className="size-4 text-accent" /> Special requests
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SpecialRequests
                requests={requests}
                onAdd={(r) => setRequests((prev) => [...prev, r])}
                onRemove={(id) => setRequests((prev) => prev.filter((x) => x.id !== id))}
              />
            </CardContent>
          </Card>
        </div>

        {/* Output column */}
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                7-day NYC forecast
              </h2>
            </div>
            <WeatherStrip days={weather} />
            <Button size="lg" onClick={generate} disabled={generating} className="mt-1 w-full">
              {generating ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> {progress || "Working…"}
                </>
              ) : (
                <>
                  <Wand2 className="size-4" /> Generate my weekly activities
                </>
              )}
            </Button>
          </section>

          {generating && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
              <Loader2 className="size-6 animate-spin text-accent" />
              <p className="text-sm font-medium">{progress || "Working…"}</p>
              <p className="text-xs text-muted-foreground">
                Live web search across NYC sources can take a few moments.
              </p>
            </div>
          )}

          {!generating && !plan && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-secondary">
                <Wand2 className="size-5 text-accent" />
              </div>
              <div className="max-w-sm">
                <p className="text-pretty font-medium">Your week, curated</p>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">
                  Set your interests, connect your calendar, add any special requests, then generate a
                  personalized list of real activities happening across NYC this week.
                </p>
              </div>
            </div>
          )}

          {!generating && plan && <WeeklyPlanView plan={plan} />}
        </div>
      </main>
    </div>
  )
}
