import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { embedQuery } from "@/lib/embeddings"
import { buildPlan } from "@/app/api/plan/route"
import { generateText, Output } from "ai"
import * as z from "zod"

// Judge-based eval endpoint. An INDEPENDENT model (Anthropic Claude — different from the app's
// OpenAI embedder + OpenAI curation LLM) grades events for relevance to the prompt, giving us an
// unbiased ground truth to score:
//   • recall@{10,25,50,80}  — for the EMBEDDING model (over the full 7-day window universe)
//   • best-event inclusion  — are the judge's "perfect" (score 3) events inside the top 80?
//   • retrieval diversity   — category / neighborhood coverage of the top 80
//   • precision@15          — for the LLM curation stage (the real buildPlan pipeline)
//
// True recall requires the FULL universe, not just the retrieved 80. All 810 in-window series
// have embeddings, so calling match_events with a large count + permissive filters returns the
// entire window ranked by cosine distance — both the ranking AND the denominator in one call.

export const maxDuration = 300

// Independent judge. Fully separate from the OpenAI embedder and gpt-5-mini curation LLM.
const JUDGE_MODEL = "anthropic/claude-sonnet-4.6"
// score >= this is treated as "relevant" for recall/precision. 0=irrelevant,1=tangential,2=relevant,3=perfect.
const RELEVANT_THRESHOLD = 2
const RECALL_KS = [10, 25, 50, 80]
const JUDGE_BATCH = 50 // events per Claude call
const JUDGE_CONCURRENCY = 4 // parallel Claude calls

const EVENT_COLUMNS =
  "id,title,description,category,start_time,end_time,venue_name,address,neighborhood,series_key"

type UniverseEvent = {
  id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  description: string | null
  series_key: string | null
}

function weekWindow(): { start: string; end: string } {
  // Today 00:00 NY → +7 days, identical to the production plan pipeline.
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const start = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  const end = new Date(new Date(start).getTime() + 7 * 86400000).toISOString()
  return { start, end }
}

const judgeSchema = z.object({
  judgements: z
    .array(
      z.object({
        index: z.number().int().describe("The 1-based index of the event as shown in the list"),
        score: z.number().int().min(0).max(3).describe("0=irrelevant, 1=tangential, 2=relevant, 3=perfect match"),
      }),
    )
    .describe("Exactly one judgement per event in the list"),
})

const RUBRIC =
  "You are an impartial relevance judge for an NYC events recommender. Given a user's request and a " +
  "list of events, score how well EACH event matches what the user is asking for. Use this scale: " +
  "3 = perfect match (clearly what they want), 2 = relevant (a good fit), 1 = tangential (loosely " +
  "related), 0 = irrelevant. Judge purely on topical/vibe/location fit with the request — ignore " +
  "date and price. Return exactly one judgement per event, using the event's 1-based index."

function eventLine(e: UniverseEvent, i: number): string {
  const loc = [e.venue_name, e.neighborhood].filter(Boolean).join(", ")
  const desc = (e.description || "").replace(/\s+/g, " ").slice(0, 240)
  return `${i + 1}. [${e.category || "Uncategorized"}] ${e.title || "Untitled"}${loc ? ` @ ${loc}` : ""}${desc ? ` — ${desc}` : ""}`
}

// Grade one batch of events; returns index->score for the batch (indices are batch-local, 1-based).
async function judgeBatch(query: string, events: UniverseEvent[]): Promise<Map<number, number>> {
  const list = events.map((e, i) => eventLine(e, i)).join("\n")
  const { output } = await generateText({
    model: JUDGE_MODEL,
    output: Output.object({ schema: judgeSchema }),
    system: RUBRIC,
    prompt: `USER REQUEST:\n"${query}"\n\nEVENTS (${events.length}):\n${list}\n\nScore every event.`,
    maxRetries: 3,
  })
  const map = new Map<number, number>()
  for (const j of output.judgements) map.set(j.index, j.score)
  return map
}

// Grade the whole universe with bounded concurrency. Returns id->score (missing => 0).
async function judgeAll(query: string, events: UniverseEvent[]): Promise<Map<string, number>> {
  const batches: UniverseEvent[][] = []
  for (let i = 0; i < events.length; i += JUDGE_BATCH) batches.push(events.slice(i, i + JUDGE_BATCH))

  const scoreById = new Map<string, number>()
  for (let i = 0; i < batches.length; i += JUDGE_CONCURRENCY) {
    const slice = batches.slice(i, i + JUDGE_CONCURRENCY)
    const results = await Promise.all(
      slice.map((b) => judgeBatch(query, b).catch(() => new Map<number, number>())),
    )
    results.forEach((batchScores, bi) => {
      const batch = slice[bi]
      batch.forEach((e, idx) => scoreById.set(e.id, batchScores.get(idx + 1) ?? 0))
    })
  }
  return scoreById
}

function normalizedCategoryEntropy(cats: string[], universeDistinct: number): number {
  if (cats.length === 0 || universeDistinct <= 1) return 0
  const counts = new Map<string, number>()
  for (const c of cats) counts.set(c, (counts.get(c) || 0) + 1)
  const n = cats.length
  let h = 0
  for (const c of counts.values()) {
    const p = c / n
    h -= p * Math.log(p)
  }
  // Normalize by the maximum achievable given how many distinct categories exist in the universe.
  return Math.min(1, h / Math.log(universeDistinct))
}

export async function POST(req: Request) {
  let body: { query?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const query = (body.query || "").trim()
  if (!query) return Response.json({ error: "Provide a non-empty `query`." }, { status: 400 })

  // 1) Embed + retrieve the FULL ranked window universe (permissive filters = model in isolation).
  const embedding = await embedQuery(query)
  if (!embedding) {
    return Response.json({ error: "Embedding failed (model unavailable or rate-limited)." }, { status: 502 })
  }
  const { start, end } = weekWindow()
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .rpc("match_events", {
      p_query_embedding: embedding,
      p_match_count: 5000, // larger than the window universe → returns everything, ranked
      p_window_start: start,
      p_window_end: end,
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
  if (error) return Response.json({ error: error.message }, { status: 500 })

  const ranked = ((data as unknown as UniverseEvent[]) || []).filter((e) => e.id)
  if (ranked.length === 0) return Response.json({ error: "No events in the window." }, { status: 404 })

  // 2) Judge the entire universe with the independent model.
  const scoreById = await judgeAll(query, ranked)

  // 3) Recall@k for the embedding model. Denominator = all relevant events in the window.
  const relevantIds = new Set(ranked.filter((e) => (scoreById.get(e.id) ?? 0) >= RELEVANT_THRESHOLD).map((e) => e.id))
  const perfectIds = new Set(ranked.filter((e) => (scoreById.get(e.id) ?? 0) === 3).map((e) => e.id))
  const totalRelevant = relevantIds.size

  const recallAtK = RECALL_KS.map((k) => {
    const topK = ranked.slice(0, k)
    const hits = topK.filter((e) => relevantIds.has(e.id)).length
    return { k, hits, recall: totalRelevant > 0 ? +(hits / totalRelevant).toFixed(4) : null }
  })

  // 4) Best-event inclusion — what fraction of the judge's "perfect" events land in the top 80?
  const top80Ids = new Set(ranked.slice(0, 80).map((e) => e.id))
  const perfectInTop80 = [...perfectIds].filter((id) => top80Ids.has(id)).length
  const bestEventInclusion = {
    perfectCount: perfectIds.size,
    perfectInTop80,
    inclusionRate: perfectIds.size > 0 ? +(perfectInTop80 / perfectIds.size).toFixed(4) : null,
  }

  // 5) Retrieval diversity of the top 80.
  const universeDistinctCats = new Set(ranked.map((e) => e.category || "Uncategorized")).size
  const top80 = ranked.slice(0, 80)
  const diversity = {
    categoriesCovered: new Set(top80.map((e) => e.category || "Uncategorized")).size,
    universeCategories: universeDistinctCats,
    neighborhoodsCovered: new Set(top80.map((e) => e.neighborhood || "Unknown")).size,
    categoryEntropyNormalized: +normalizedCategoryEntropy(
      top80.map((e) => e.category || "Uncategorized"),
      universeDistinctCats,
    ).toFixed(4),
  }

  // 6) Precision@15 for the LLM curation stage — run the REAL pipeline (permissive profile), then
  //    judge its picks with the same rubric (dedup picks by id first).
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
    requests: query ? [{ text: query }] : [],
  }
  let llmPrecision: {
    picked: number
    relevant: number
    precision: number | null
    picks: { rank: number; id: string; title: string; category: string; score: number }[]
  } = { picked: 0, relevant: 0, precision: null, picks: [] }

  try {
    const plan = await buildPlan(planBody)
    const seen = new Set<string>()
    const picks = (plan.activities || []).filter((a: { id: string }) => {
      if (seen.has(a.id)) return false
      seen.add(a.id)
      return true
    })
    if (picks.length > 0) {
      // Judge the picks directly (same rubric) so ids that differ from the universe reps still score.
      const pickEvents: UniverseEvent[] = picks.map((a: any) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        venue_name: a.venue,
        neighborhood: a.neighborhood,
        description: a.why || "",
        series_key: null,
      }))
      const pickScoresByIdx = await judgeBatch(query, pickEvents)
      const scored = picks.map((a: any, i: number) => ({
        rank: i + 1,
        id: a.id,
        title: a.title,
        category: a.category || "",
        score: pickScoresByIdx.get(i + 1) ?? 0,
      }))
      const relevant = scored.filter((p) => p.score >= RELEVANT_THRESHOLD).length
      llmPrecision = {
        picked: scored.length,
        relevant,
        precision: +(relevant / scored.length).toFixed(4),
        picks: scored,
      }
    }
  } catch (err) {
    console.log("[v0] judge precision@15 failed:", err instanceof Error ? err.message : err)
  }

  // Per-event judged rows (ranked) for download / auditing.
  const judged = ranked.map((e, i) => ({
    rank: i + 1,
    id: e.id,
    title: e.title,
    category: e.category,
    venue_name: e.venue_name,
    neighborhood: e.neighborhood,
    score: scoreById.get(e.id) ?? 0,
    relevant: (scoreById.get(e.id) ?? 0) >= RELEVANT_THRESHOLD,
  }))

  return Response.json({
    query,
    judgeModel: JUDGE_MODEL,
    relevantThreshold: RELEVANT_THRESHOLD,
    generatedAt: new Date().toISOString(),
    universeSize: ranked.length,
    totalRelevant,
    embedding: { recallAtK, bestEventInclusion, diversity },
    llm: llmPrecision,
    judged,
  })
}
