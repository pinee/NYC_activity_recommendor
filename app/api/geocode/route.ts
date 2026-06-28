import { NextResponse } from "next/server"

export const maxDuration = 15

// NYC bias center (Manhattan) for ranking nearby results first.
const NYC_LAT = 40.7549
const NYC_LON = -73.984

interface PhotonFeature {
  properties: {
    name?: string
    housenumber?: string
    street?: string
    city?: string
    district?: string
    state?: string
    postcode?: string
    country?: string
    osm_id?: number
  }
}

function formatLabel(p: PhotonFeature["properties"]): string {
  const line1 = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || ""
  const locality = p.district || p.city || ""
  const parts = [line1, locality, p.state, p.postcode].filter(Boolean)
  return parts.join(", ")
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get("q")?.trim()
  if (!q || q.length < 3) {
    return NextResponse.json({ suggestions: [] })
  }

  try {
    const url = new URL("https://photon.komoot.io/api/")
    url.searchParams.set("q", q)
    url.searchParams.set("limit", "6")
    url.searchParams.set("lang", "en")
    url.searchParams.set("lat", String(NYC_LAT))
    url.searchParams.set("lon", String(NYC_LON))

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "nyc-activities-planner" },
    })
    if (!res.ok) throw new Error(`Photon ${res.status}`)

    const data = (await res.json()) as { features?: PhotonFeature[] }
    const seen = new Set<string>()
    const suggestions = (data.features || [])
      .map((f) => formatLabel(f.properties))
      .filter((label) => {
        if (!label || seen.has(label)) return false
        seen.add(label)
        return true
      })
      .map((label, i) => ({ id: `${i}-${label}`, label }))

    return NextResponse.json({ suggestions })
  } catch (err) {
    console.log("[v0] geocode error:", err instanceof Error ? err.message : err)
    return NextResponse.json({ suggestions: [] })
  }
}
