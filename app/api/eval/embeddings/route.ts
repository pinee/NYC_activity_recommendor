import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { embedQuery } from "@/lib/embeddings"

export const maxDuration = 60

// Eval-only endpoint for measuring the embedding model (recall@K). It runs ONLY the semantic
// retrieval path — embed the prompt, then match_events() — and returns the ranked events exactly
// as the app's embedding stage would pick them, so the results can be scored for recall.
//
// The hard profile filters (budget / working hours / travel / approximate location) are
// DELIBERATELY LEFT PERMISSIVE here: recall@K should measure the embedding model in isolation, not
// a particular user's filters. Only the date window is applied, controlled by `scope`.

// Same projection the production plan route selects.
const EVENT_COLUMNS =
  "id,title,description,category,start_time,end_time,venue_name,address,latitude,longitude,event_url,source,price,image_url,neighborhood,approximate_location,series_key"

type Scope = "week" | "all"

function windowFor(scope: Scope): { start: string; end: string } {
  if (scope === "all") {
    // Whole catalog — best for pure embedding recall over everything stored.
    return { start: "2000-01-01T00:00:00.000Z", end: "2100-01-01T00:00:00.000Z" }
  }
  // "week": today 00:00 NY → +7 days, matching the production plan pipeline.
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const start = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  const end = new Date(new Date(start).getTime() + 7 * 86400000).toISOString()
  return { start, end }
}

export async function POST(req: Request) {
  let body: { query?: string; matchCount?: number; scope?: Scope }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const query = (body.query || "").trim()
  if (!query) {
    return Response.json({ error: "Provide a non-empty `query`." }, { status: 400 })
  }

  const matchCount = Math.min(Math.max(Number(body.matchCount) || 80, 1), 500)
  const scope: Scope = body.scope === "all" ? "all" : "week"

  const embedding = await embedQuery(query)
  if (!embedding) {
    return Response.json(
      { error: "Embedding failed (model unavailable or rate-limited). Try again." },
      { status: 502 },
    )
  }

  const { start, end } = windowFor(scope)
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .rpc("match_events", {
      p_query_embedding: embedding,
      p_match_count: matchCount,
      p_window_start: start,
      p_window_end: end,
      // Permissive filters — see header note.
      p_budget_cap: null,
      p_include_approx: true,
      p_home_lat: null,
      p_home_lng: null,
      p_office_lat: null,
      p_office_lng: null,
      p_max_travel: null,
      p_workday_dows: [],
      p_work_start_min: null,
      p_work_end_min: null,
    })
    .select(EVENT_COLUMNS)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Returned in cosine-distance order; attach an explicit 1-based rank for scoring.
  const events = ((data as unknown as Record<string, unknown>[]) || []).map((row, i) => ({
    rank: i + 1,
    ...row,
  }))

  return Response.json({
    query,
    scope,
    matchCount,
    returned: events.length,
    generatedAt: new Date().toISOString(),
    events,
  })
}
