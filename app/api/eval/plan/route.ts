import { buildPlan } from "@/app/api/plan/route"

export const maxDuration = 120

// Eval-only endpoint for inspecting the LLM ranking stage (the top-15 curated picks).
//
// It reuses the REAL production pipeline (buildPlan: filter -> fetch -> embed -> LLM curate ->
// top 15) so what you download matches exactly what the app would show — but it bypasses the
// /api/plan streaming + 30-minute cache layer, so every call genuinely re-invokes the model.
// That is what lets you observe run-to-run variation for the same prompt.
//
// The profile is deliberately PERMISSIVE (no interests, no addresses, no workdays, "any" budget,
// approximate locations included) so the candidate pool matches the embeddings eval and the only
// thing under test is the LLM's selection from the semantically-retrieved events.

export async function POST(req: Request) {
  let body: { query?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const query = (body.query || "").trim()
  if (!query) {
    return Response.json({ error: "Provide a non-empty `query`." }, { status: 400 })
  }

  const planBody = {
    profile: {
      interests: [],
      homeAddress: "",
      officeAddress: "",
      budget: "any",
      workDays: [],
      workStart: "09:00",
      workEnd: "17:00",
      maxTravelMinutes: 999,
      includeApproximateLocations: true,
    },
    weather: [],
    events: [],
    requests: [{ text: query }],
  }

  try {
    const plan = await buildPlan(planBody)
    const activities = (plan.activities || []).map((a, i) => ({ rank: i + 1, ...a }))
    return Response.json({
      query,
      generatedAt: new Date().toISOString(),
      summary: plan.summary,
      count: activities.length,
      activities,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const rateLimited = /rate-?limit|too many requests|free tier|paid credits|429/i.test(message)
    return Response.json(
      { error: rateLimited ? "AI Gateway rate limit hit. Wait a moment and retry." : message },
      { status: rateLimited ? 429 : 500 },
    )
  }
}
