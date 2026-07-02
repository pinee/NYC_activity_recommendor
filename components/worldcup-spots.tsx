"use client"

import { MapPin, CalendarRange, ExternalLink, Sun, Building, Home, Briefcase, Globe, Repeat } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { WorldCupSpot, WorldCupSpotsResult } from "@/lib/types"

function normalizeUrl(url: string): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (!/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return null
  return `https://${trimmed}`
}

function SpotCard({ spot }: { spot: WorldCupSpot }) {
  const sourceUrl = normalizeUrl(spot.url)
  const imageUrl = spot.imageUrl ? normalizeUrl(spot.imageUrl) : null
  const mapsQuery = encodeURIComponent(
    [spot.venue, spot.address, spot.neighborhood, "New York, NY"].filter(Boolean).join(", "),
  )
  return (
    <article className="group flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/20">
      {imageUrl && (
        <div className="-mx-px -mt-px aspect-[16/9] w-[calc(100%+2px)] overflow-hidden bg-secondary">
          <img
            src={imageUrl || "/placeholder.svg"}
            alt={`Watching the World Cup at ${spot.name}`}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            crossOrigin="anonymous"
            onError={(e) => {
              const wrapper = (e.currentTarget as HTMLImageElement).parentElement
              if (wrapper) wrapper.style.display = "none"
            }}
          />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-accent text-accent-foreground hover:bg-accent">
                {spot.indoor ? "Indoor" : "Outdoor"}
              </Badge>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {spot.indoor ? <Building className="size-3" /> : <Sun className="size-3" />}
                {spot.indoor ? "Indoor viewing" : "Outdoor viewing"}
              </span>
            </div>
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pretty text-base font-semibold leading-snug underline-offset-2 hover:text-accent hover:underline"
              >
                {spot.name}
              </a>
            ) : (
              <h4 className="text-pretty text-base font-semibold leading-snug">{spot.name}</h4>
            )}
          </div>
          <span className="shrink-0 rounded-md bg-secondary px-2 py-1 text-xs font-medium">
            {spot.priceLabel || "—"}
          </span>
        </div>

        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <CalendarRange className="size-3.5 shrink-0 text-accent" />
            <span className="font-medium text-foreground">{spot.dateSpanLabel}</span>
          </span>
          {spot.sessions > 1 && (
            <span className="flex items-center gap-2">
              <Repeat className="size-3.5 shrink-0" />
              <span>
                {spot.sessions} viewing sessions
              </span>
            </span>
          )}
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 underline-offset-2 hover:text-accent hover:underline"
          >
            <MapPin className="size-3.5 shrink-0" />
            <span>
              {spot.neighborhood ? (
                <span className="text-foreground">{spot.neighborhood}</span>
              ) : (
                <span className="text-foreground">New York, NY</span>
              )}
            </span>
          </a>
        </div>

        {(spot.travelFromHome || spot.travelFromOffice) && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
            {spot.travelFromHome && (
              <span className="flex items-center gap-2">
                <Home className="size-3.5 shrink-0 text-accent" />
                <span className="text-muted-foreground">From home</span>
                <span className="ml-auto font-medium tabular-nums text-foreground">{spot.travelFromHome}</span>
              </span>
            )}
            {spot.travelFromOffice && (
              <span className="flex items-center gap-2">
                <Briefcase className="size-3.5 shrink-0 text-accent" />
                <span className="text-muted-foreground">From office</span>
                <span className="ml-auto font-medium tabular-nums text-foreground">{spot.travelFromOffice}</span>
              </span>
            )}
            {spot.approximateLocation && (
              <span className="text-[11px] italic text-muted-foreground">
                Approximate location — travel time is an estimate
              </span>
            )}
          </div>
        )}

        {sourceUrl && (
          <div className="mt-auto flex items-center justify-end pt-1">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              Details <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
      </div>
    </article>
  )
}

export function WorldCupSpotsView({ result }: { result: WorldCupSpotsResult }) {
  return (
    <div className="flex flex-col gap-6">
      {result.summary && (
        <p className="text-pretty text-base leading-relaxed text-muted-foreground">{result.summary}</p>
      )}

      {result.spots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            No World Cup viewing spots are in the catalog right now. Check back after the next daily update.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {result.spots.map((s) => (
            <SpotCard key={s.id} spot={s} />
          ))}
        </div>
      )}

      {result.sources && result.sources.length > 0 && (
        <section className="flex flex-col gap-3 border-t border-border pt-6">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-accent" />
            <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Sources searched ({result.sources.length})
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {result.sources.map((s) => (
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
