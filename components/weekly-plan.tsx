"use client"

import { MapPin, Clock, ExternalLink, Sun, Building, ArrowRight, Home, Briefcase, Globe } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Activity, WeeklyPlan } from "@/lib/types"

function normalizeUrl(url: string): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  // Already has a protocol (http, https, etc.)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  // Reject anything that isn't a plausible domain (avoids relative-path 404s)
  if (!/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return null
  return `https://${trimmed}`
}

function ActivityCard({ activity }: { activity: Activity }) {
  const sourceUrl = normalizeUrl(activity.url)
  return (
    <article className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-accent text-accent-foreground hover:bg-accent">{activity.category}</Badge>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {activity.indoor ? <Building className="size-3" /> : <Sun className="size-3" />}
              {activity.indoor ? "Indoor" : "Outdoor"}
            </span>
          </div>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-pretty text-base font-semibold leading-snug underline-offset-2 hover:text-accent hover:underline"
            >
              {activity.title}
            </a>
          ) : (
            <h4 className="text-pretty text-base font-semibold leading-snug">{activity.title}</h4>
          )}
        </div>
        <span className="shrink-0 rounded-md bg-secondary px-2 py-1 text-xs font-medium">
          {activity.priceLabel || "—"}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        {(activity.startTime || activity.endTime) && (
          <span className="flex items-center gap-2">
            <Clock className="size-3.5 shrink-0" />
            <span className="tabular-nums">
              {activity.startTime}
              {activity.endTime ? `–${activity.endTime}` : ""}
            </span>
          </span>
        )}
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            [activity.venue, activity.address, activity.neighborhood, "New York, NY"].filter(Boolean).join(", "),
          )}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 underline-offset-2 hover:text-accent hover:underline"
        >
          <MapPin className="size-3.5 shrink-0" />
          <span>
            <span className="text-foreground">{activity.venue}</span>
            {activity.neighborhood ? ` · ${activity.neighborhood}` : ""}
          </span>
        </a>
      </div>

      {activity.why && <p className="text-pretty text-sm leading-relaxed">{activity.why}</p>}

      {(activity.travelFromHome || activity.travelFromOffice) && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
          {activity.travelFromHome && (
            <span className="flex items-center gap-2">
              <Home className="size-3.5 shrink-0 text-accent" />
              <span className="text-muted-foreground">From home</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">{activity.travelFromHome}</span>
            </span>
          )}
          {activity.travelFromOffice && (
            <span className="flex items-center gap-2">
              <Briefcase className="size-3.5 shrink-0 text-accent" />
              <span className="text-muted-foreground">From office</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">{activity.travelFromOffice}</span>
            </span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        {activity.travelNote ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowRight className="size-3" /> {activity.travelNote}
          </span>
        ) : (
          <span />
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            Details <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </article>
  )
}

function formatDateLabel(iso: string, fallbackDay: string): string {
  // Parse as a plain calendar date (avoid UTC shift) and format as "Wednesday · Jun 24".
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return fallbackDay
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
}

export function WeeklyPlanView({ plan }: { plan: WeeklyPlan }) {
  // Group by the activity's real date, ordered chronologically from today.
  const groups = new Map<string, Activity[]>()
  for (const a of plan.activities) {
    const key = a.date || a.day
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(a)
  }
  const byDay = Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      label: formatDateLabel(key, items[0]?.day ?? key),
      items: items.sort((x, y) => (x.startTime || "").localeCompare(y.startTime || "")),
    }))

  return (
    <div className="flex flex-col gap-8">
      {plan.summary && (
        <p className="text-pretty text-base leading-relaxed text-muted-foreground">{plan.summary}</p>
      )}
      {byDay.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            No activities matched your selected interests this week. Try adding more interests, widening your travel
            time, or increasing your variety preference.
          </p>
        </div>
      )}
      {byDay.map(({ key, label, items }) => (
        <section key={key} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h3 className="font-mono text-sm font-semibold uppercase tracking-widest">{label}</h3>
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">
              {items.length} {items.length === 1 ? "activity" : "activities"}
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((a) => (
              <ActivityCard key={a.id} activity={a} />
            ))}
          </div>
        </section>
      ))}

      {plan.sources && plan.sources.length > 0 && (
        <section className="flex flex-col gap-3 border-t border-border pt-6">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-accent" />
            <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Sources searched ({plan.sources.length})
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {plan.sources.map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
              >
                <Globe className="size-3" />
                {s.host}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
