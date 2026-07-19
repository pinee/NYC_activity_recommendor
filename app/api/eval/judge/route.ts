import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { embedQuery } from "@/lib/embeddings"
import { generateText, Output } from "ai"
import * as z from "zod"

// Recall@80 eval for the EMBEDDING model, using an INDEPENDENT judge (Anthropic Claude — different
// from the app's OpenAI embedder) as ground truth.
//
//   recall@80 = (relevant events in the embedding's top 80) / (ALL relevant events in the window)
//
// True recall needs the full universe as denominator, not just the retrieved 80. Every in-window
// series has an embedding, so calling match_events with a huge count + permissive filters returns
// the entire 7-day window ranked by cosine distance — the ranking AND the denominator in one call.
// Claude then grades every event, and we report recall@80 plus the relevant events the embedding
// model MISSED (relevant per Claude but outside the top 80).

export const maxDuration = 300

// Independent judge. Fully separate from the OpenAI embedding model under test.
// Haiku is ~10x cheaper than Sonnet per run and well-suited to relevance grading, so a single
// AI Gateway top-up covers many more recall@80 evals. Still fully independent of OpenAI.
const JUDGE_MODEL = "anthropic/claude-haiku-4.5"
// score >= this is treated as "relevant". 0=irrelevant, 1=tangential, 2=relevant, 3=perfect.
const RELEVANT_THRESHOLD = 2
const TOP_K = 80
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
// Retries on rate-limit with exponential backoff (the AI Gateway free tier limits requests
// aggressively). Throws if it ultimately fails, so the caller can distinguish a genuine
// "no relevant events" result from a judging failure — never conflate the two.
async function judgeBatch(query: string, events: UniverseEvent[]): Promise<Map<number, number>> {
  const list = events.map((e, i) => eventLine(e, i)).join("\n")
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rateLimited = /rate.?limit|429|too many|quota|overloaded|503/i.test(message)
      if (rateLimited && attempt < maxAttempts - 1) {
        const waitMs = 2000 * 2 ** attempt // 2s, 4s, 8s, 16s
        console.log(`[v0] judgeBatch rate-limited, backing off ${waitMs}ms (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
  throw new Error("judgeBatch exhausted retries")
}

// Grade the whole universe with bounded concurrency. Returns id->score plus the number of
// batches that failed even after retries, so the caller can reject partial/invalid results
// rather than silently reporting missed events as "irrelevant" (score 0).
async function judgeAll(
  query: string,
  events: UniverseEvent[],
): Promise<{ scoreById: Map<string, number>; failedBatches: number }> {
  const batches: UniverseEvent[][] = []
  for (let i = 0; i < events.length; i += JUDGE_BATCH) batches.push(events.slice(i, i + JUDGE_BATCH))

  const scoreById = new Map<string, number>()
  let failedBatches = 0
  for (let i = 0; i < batches.length; i += JUDGE_CONCURRENCY) {
    const slice = batches.slice(i, i + JUDGE_CONCURRENCY)
    const results = await Promise.all(
      slice.map((b) =>
        judgeBatch(query, b)
          .then((m) => ({ ok: true as const, m }))
          .catch(() => ({ ok: false as const, m: new Map<number, number>() })),
      ),
    )
    results.forEach((res, bi) => {
      if (!res.ok) {
        failedBatches++
        return // leave these events unscored; do NOT default them to 0
      }
      const batch = slice[bi]
      batch.forEach((e, idx) => scoreById.set(e.id, res.m.get(idx + 1) ?? 0))
    })
  }
  return { scoreById, failedBatches }
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
    return Response.json(
      {
        error:
          "Embedding request failed. The most common cause is an exhausted AI Gateway credit balance " +
          "(HTTP 402) — add credits in your Vercel project's AI settings and retry. It can also be a " +
          "transient rate-limit or model outage.",
      },
      { status: 502 },
    )
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

  // rank (1-based) each event carries its embedding-cosine position in the full window.
  const rankById = new Map<string, number>()
  ranked.forEach((e, i) => rankById.set(e.id, i + 1))

  // 2) Judge the entire universe with the independent model.
  const { scoreById, failedBatches } = await judgeAll(query, ranked)
  // If any batch failed even after retries, the denominator would be wrong — surface an error
  // instead of reporting a misleading recall built on partially-judged data.
  if (failedBatches > 0) {
    return Response.json(
      {
        error: `Judge model rate-limited: ${failedBatches} batch(es) failed after retries. Recall would be inaccurate — please retry in a minute.`,
      },
      { status: 502 },
    )
  }

  // 3) recall@80 for the embedding model. Denominator = ALL relevant events in the window.
  const top80Ids = new Set(ranked.slice(0, TOP_K).map((e) => e.id))
  const relevantEvents = ranked
    .filter((e) => (scoreById.get(e.id) ?? 0) >= RELEVANT_THRESHOLD)
    .map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      venue_name: e.venue_name,
      neighborhood: e.neighborhood,
      score: scoreById.get(e.id) ?? 0,
      rank: rankById.get(e.id) ?? null, // position in the embedding ranking
      inTop80: top80Ids.has(e.id),
    }))
    // Highest judge score first, then by embedding rank.
    .sort((a, b) => b.score - a.score || (a.rank ?? 1e9) - (b.rank ?? 1e9))

  const totalRelevant = relevantEvents.length
  const capturedInTop80 = relevantEvents.filter((e) => e.inTop80).length
  const recallAt80 = totalRelevant > 0 ? +(capturedInTop80 / totalRelevant).toFixed(4) : null

  // 4) The embedding model's top 80 (what the app would feed the LLM), with judge scores attached.
  const top80 = ranked.slice(0, TOP_K).map((e, i) => ({
    rank: i + 1,
    id: e.id,
    title: e.title,
    category: e.category,
    venue_name: e.venue_name,
    neighborhood: e.neighborhood,
    score: scoreById.get(e.id) ?? 0,
    relevant: (scoreById.get(e.id) ?? 0) >= RELEVANT_THRESHOLD,
  }))

  // 5) Misses — relevant per Claude but NOT in the embedding top 80 (the recall gap).
  const misses = relevantEvents.filter((e) => !e.inTop80)

  return Response.json({
    query,
    judgeModel: JUDGE_MODEL,
    relevantThreshold: RELEVANT_THRESHOLD,
    topK: TOP_K,
    generatedAt: new Date().toISOString(),
    universeSize: ranked.length,
    totalRelevant,
    capturedInTop80,
    recallAt80,
    top80,
    relevantEvents,
    misses,
  })
}
