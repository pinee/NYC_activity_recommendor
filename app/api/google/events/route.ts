import { NextResponse, type NextRequest } from "next/server"
import {
  COOKIE_ACCESS,
  COOKIE_EXPIRY,
  COOKIE_REFRESH,
  googleConfigured,
  refreshAccessToken,
} from "@/lib/google"
import type { CalendarEvent, WeekDay } from "@/lib/types"

const DAY_MAP: WeekDay[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function toWeekDay(d: Date): WeekDay {
  return DAY_MAP[d.getDay()]
}

function timeStr(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  })
}

export async function GET(req: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.json({ configured: false, connected: false, events: [] })
  }

  let accessToken = req.cookies.get(COOKIE_ACCESS)?.value
  const refreshToken = req.cookies.get(COOKIE_REFRESH)?.value
  const expiry = Number(req.cookies.get(COOKIE_EXPIRY)?.value ?? 0)

  let refreshedAccess: string | null = null
  let refreshedExpiry: number | null = null

  const needsRefresh = !accessToken || Date.now() > expiry - 60_000
  if (needsRefresh && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken)
    if (refreshed.access_token) {
      accessToken = refreshed.access_token
      refreshedAccess = refreshed.access_token
      refreshedExpiry = Date.now() + (refreshed.expires_in ?? 3600) * 1000
    }
  }

  if (!accessToken) {
    return NextResponse.json({ configured: true, connected: false, events: [] })
  }

  const now = new Date()
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: weekAhead.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  })

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (calRes.status === 401) {
    return NextResponse.json({ configured: true, connected: false, events: [] })
  }
  if (!calRes.ok) {
    return NextResponse.json(
      { configured: true, connected: true, events: [], error: "Calendar fetch failed" },
      { status: 200 },
    )
  }

  const data = await calRes.json()
  const events: CalendarEvent[] = (data.items ?? [])
    .filter((item: any) => item.start?.dateTime)
    .map((item: any) => {
      const start = new Date(item.start.dateTime)
      const end = new Date(item.end?.dateTime ?? item.start.dateTime)
      return {
        id: item.id,
        title: item.summary ?? "Busy",
        day: toWeekDay(start),
        start: timeStr(start),
        end: timeStr(end),
        source: "google" as const,
      }
    })

  const res = NextResponse.json({ configured: true, connected: true, events })
  if (refreshedAccess && refreshedExpiry) {
    const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" }
    res.cookies.set(COOKIE_ACCESS, refreshedAccess, {
      ...opts,
      maxAge: Math.floor((refreshedExpiry - Date.now()) / 1000),
    })
    res.cookies.set(COOKIE_EXPIRY, String(refreshedExpiry), {
      ...opts,
      maxAge: 60 * 60 * 24 * 30,
    })
  }
  return res
}
