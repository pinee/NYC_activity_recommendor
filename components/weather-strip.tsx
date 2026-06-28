"use client"

import { Cloud, CloudRain, CloudSnow, Sun, CloudFog, Zap, CloudDrizzle } from "lucide-react"
import type { WeatherDay } from "@/lib/types"
import { cn } from "@/lib/utils"

function WeatherIcon({ condition, className }: { condition: string; className?: string }) {
  const c = condition.toLowerCase()
  if (c.includes("thunder")) return <Zap className={className} />
  if (c.includes("snow")) return <CloudSnow className={className} />
  if (c.includes("drizzle")) return <CloudDrizzle className={className} />
  if (c.includes("rain")) return <CloudRain className={className} />
  if (c.includes("fog")) return <CloudFog className={className} />
  if (c.includes("overcast")) return <Cloud className={className} />
  return <Sun className={className} />
}

export function WeatherStrip({ days }: { days: WeatherDay[] }) {
  if (days.length === 0) return null
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
      {days.map((d, i) => (
        <div
          key={d.date}
          className={cn(
            "flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center",
            d.outdoorFriendly ? "border-accent/40 bg-accent/5" : "border-border bg-card",
          )}
        >
          <span className="text-xs font-medium text-muted-foreground">{i === 0 ? "Today" : d.label}</span>
          <WeatherIcon
            condition={d.condition}
            className={cn("size-5", d.outdoorFriendly ? "text-accent" : "text-muted-foreground")}
          />
          <span className="text-sm font-semibold tabular-nums">{d.high}°</span>
          <span className="text-xs tabular-nums text-muted-foreground">{d.low}°</span>
        </div>
      ))}
    </div>
  )
}
