import { getWorldCupSpots } from "@/lib/worldcup"

export const maxDuration = 30

// Standalone browse of every World Cup & soccer viewing SPOT in the catalog — the same data
// the weekly planner attaches for the "World Cup & Soccer" interest (see lib/worldcup.ts),
// exposed here so users can view all locations without generating a full plan.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const profile = body?.profile ?? {}
    const result = await getWorldCupSpots(profile)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[v0] world cup browse error:", message)
    return Response.json({ error: "Could not load World Cup events. Please try again." }, { status: 500 })
  }
}
