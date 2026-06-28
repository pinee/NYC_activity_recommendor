import { NextResponse } from "next/server"
import { WEEK_DAYS, type WeatherDay, type WeekDay } from "@/lib/types"

// NYC (Manhattan) coordinates
const LAT = 40.7128
const LON = -74.006

// WMO weather interpretation codes -> human label + outdoor friendliness
function describeCode(code: number): { condition: string; outdoorFriendly: boolean } {
  if (code === 0) return { condition: "Clear sky", outdoorFriendly: true }
  if (code <= 2) return { condition: "Mostly sunny", outdoorFriendly: true }
  if (code === 3) return { condition: "Overcast", outdoorFriendly: true }
  if (code <= 48) return { condition: "Foggy", outdoorFriendly: false }
  if (code <= 57) return { condition: "Drizzle", outdoorFriendly: false }
  if (code <= 67) return { condition: "Rain", outdoorFriendly: false }
  if (code <= 77) return { condition: "Snow", outdoorFriendly: false }
  if (code <= 82) return { condition: "Rain showers", outdoorFriendly: false }
  if (code <= 86) return { condition: "Snow showers", outdoorFriendly: false }
  return { condition: "Thunderstorm", outdoorFriendly: false }
}

function dayFromISO(iso: string): WeekDay {
  // JS getUTCDay: 0=Sun..6=Sat. Use noon to avoid TZ edge cases.
  const d = new Date(`${iso}T12:00:00`)
  const jsDay = d.getDay() // local
  const map: WeekDay[] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]
  return map[jsDay] ?? WEEK_DAYS[0]
}

export async function GET() {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=7`

    const res = await fetch(url, { next: { revalidate: 1800 } })
    if (!res.ok) {
      return NextResponse.json({ error: "Weather provider error" }, { status: 502 })
    }
    const data = await res.json()
    const daily = data.daily

    const days: WeatherDay[] = (daily.time as string[]).map((date, i) => {
      const { condition, outdoorFriendly } = describeCode(daily.weather_code[i])
      const day = dayFromISO(date)
      const precip = Math.round(daily.precipitation_probability_max?.[i] ?? 0)
      return {
        date,
        day,
        label: day.slice(0, 3),
        high: Math.round(daily.temperature_2m_max[i]),
        low: Math.round(daily.temperature_2m_min[i]),
        condition,
        precipProbability: precip,
        outdoorFriendly: outdoorFriendly && precip < 55,
      }
    })

    return NextResponse.json({ days })
  } catch {
    return NextResponse.json({ error: "Failed to load weather" }, { status: 500 })
  }
}
