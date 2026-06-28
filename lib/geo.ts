// Lightweight, dependency-free geo helpers used for DETERMINISTIC travel-time
// filtering. Travel estimates here are straight-line approximations (no routing API),
// intended to enforce the user's max-travel preference, not to be turn-by-turn accurate.

export type Coord = { lat: number; lng: number }

// Great-circle distance between two points, in kilometers (Haversine formula).
export function haversineKm(a: Coord, b: Coord): number {
  const R = 6371 // Earth radius (km)
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

// Convert a straight-line distance into an estimated one-way travel time in minutes.
// We inflate the distance by a detour factor (real routes aren't straight) and assume
// a conservative average city speed that blends walking + subway/bus.
const DETOUR_FACTOR = 1.3 // streets/transit add ~30% over the crow-flies distance
const AVG_CITY_SPEED_KMH = 16 // door-to-door average incl. walking/waiting

export function estimateTravelMinutes(from: Coord, to: Coord): number {
  const km = haversineKm(from, to) * DETOUR_FACTOR
  const minutes = (km / AVG_CITY_SPEED_KMH) * 60
  // Round to the nearest 5 minutes so the estimate reads as approximate.
  return Math.max(5, Math.round(minutes / 5) * 5)
}

// ---- Geocoding (free, no API key) -------------------------------------------------
// Uses the U.S. Census Geocoder, which is free and key-less for US street addresses.
// Results are cached in-process so repeated plan generations don't re-fetch.

const geocodeCache = new Map<string, Coord | null>()

export async function geocodeAddress(address: string | undefined | null): Promise<Coord | null> {
  const query = (address || "").trim()
  if (!query) return null
  if (geocodeCache.has(query)) return geocodeCache.get(query) ?? null

  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) {
      geocodeCache.set(query, null)
      return null
    }
    const data = await res.json()
    const match = data?.result?.addressMatches?.[0]?.coordinates
    if (match && typeof match.x === "number" && typeof match.y === "number") {
      const coord: Coord = { lat: match.y, lng: match.x }
      geocodeCache.set(query, coord)
      return coord
    }
    geocodeCache.set(query, null)
    return null
  } catch {
    // Network/timeout/parse failure — treat as "unknown location" and skip travel filtering.
    geocodeCache.set(query, null)
    return null
  }
}
