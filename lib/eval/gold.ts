import { createServiceClient } from "@/lib/supabase/server"
import { nyToUtcISO } from "@/lib/event-sources/util"
import { generateText, Output } from "ai"
import * as z from "zod"

// ---------------------------------------------------------------------------
// Shared helpers for the frozen, audited gold-set recall benchmark.
//
// The benchmark reproduces the app's real retrieval path: the same OpenAI query
// embedding + the same match_events window universe the production plan pipeline
// uses. A strong INDEPENDENT judge (Anthropic Sonnet) labels every event in the
// window ONCE, with reasoning. Those labels + the corpus + the event embedding
// vectors are then frozen, so recall@k is deterministic and free of judge noise.
// ---------------------------------------------------------------------------

// Strong labeling model. Independent of the OpenAI embedder under test. Used only for the
// one-time labeling pass (not on every eval), so the higher per-call cost is bounded.
export const LABEL_MODEL = "anthropic/claude-sonnet-4.6"

// Strict relevance bar: an event counts as relevant only at score 3 (perfect match).
// This minimizes false positives that would unfairly depress the embedder's recall.
export const RELEVANT_THRESHOLD = 3

// Recall cutoffs. 80 is the headline (production SEMANTIC_MATCH_COUNT); 40/160 bracket it.
export const K_VALUES = [40, 80, 160]

const JUDGE_BATCH = 40 // events per Sonnet call
const JUDGE_CONCURRENCY = 3 // parallel Sonnet calls

export type WindowUniverseEvent = {
  id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  description: string | null
  embedding: number[] | null
}

export type Judgement = { score: number; reasoning: string }

// Today 00:00 NY → +7 days, identical to the production plan pipeline window.
export function weekWindow(): { start: string; end: string } {
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const start = nyToUtcISO(todayNY, "00:00") ?? new Date().toISOString()
  const end = new Date(new Date(start).getTime() + 7 * 86400000).toISOString()
  return { start, end }
}

// pgvector comes back from PostgREST as a JSON-ish string "[0.1,0.2,...]"; normalize to number[].
export function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[]
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr : null
    } catch {
      return null
    }
  }
  return null
}

// Retrieve the FULL windowed universe exactly as production defines it (via match_events),
// then attach each event's frozen embedding vector so the snapshot is self-contained.
// The query embedding only affects ordering here; universe membership is filter-driven, so
// the returned set is the complete window regardless of ordering.
export async function retrieveWindowUniverse(queryEmbedding: number[]): Promise<WindowUniverseEvent[]> {
  const { start, end } = weekWindow()
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .rpc("match_events", {
      p_query_embedding: queryEmbedding,
      p_match_count: 5000, // larger than the window → returns everything, ranked
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
    .select("id,title,description,category,venue_name,neighborhood")
  if (error) throw new Error(`match_events failed: ${error.message}`)

  const rows = ((data as unknown as WindowUniverseEvent[]) || []).filter((e) => e.id)
  if (rows.length === 0) return []

  // Fetch embeddings for the universe IDs so we can freeze the corpus vectors.
  // Chunk the IDs: a single .in() with hundreds of IDs overflows PostgREST's URL length limit.
  const ids = rows.map((r) => r.id)
  const embById = new Map<string, number[] | null>()
  const ID_CHUNK = 100
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data: embRows, error: embErr } = await supabase.from("events").select("id,embedding").in("id", chunk)
    if (embErr) throw new Error(`embedding fetch failed: ${embErr.message}`)
    for (const r of (embRows as { id: string; embedding: unknown }[]) || []) {
      embById.set(r.id, parseEmbedding(r.embedding))
    }
  }
  return rows.map((r) => ({ ...r, embedding: embById.get(r.id) ?? null }))
}

const judgeSchema = z.object({
  judgements: z
    .array(
      z.object({
        index: z.number().int().describe("The 1-based index of the event as shown in the list"),
        score: z.number().int().min(0).max(3).describe("0=irrelevant, 1=tangential, 2=relevant, 3=perfect match"),
        reasoning: z.string().describe("One concise sentence justifying the score"),
      }),
    )
    .describe("Exactly one judgement per event in the list"),
})

const RUBRIC =
  "You are an impartial relevance judge for an NYC events recommender. Given a user's request and a " +
  "list of events, score how well EACH event matches what the user is asking for. Use this scale: " +
  "3 = perfect match (clearly and specifically what they asked for), 2 = relevant (a good fit), " +
  "1 = tangential (loosely related), 0 = irrelevant. Be strict and discerning: reserve 3 for events " +
  "that genuinely satisfy the request's intent, vibe, and any location cues. Judge on topical/vibe/" +
  "location fit only — ignore date and price. For each event give one concise sentence of reasoning " +
  "and a score, using the event's 1-based index. Return exactly one judgement per event."

function eventLine(e: WindowUniverseEvent, i: number): string {
  const loc = [e.venue_name, e.neighborhood].filter(Boolean).join(", ")
  const desc = (e.description || "").replace(/\s+/g, " ").slice(0, 240)
  return `${i + 1}. [${e.category || "Uncategorized"}] ${e.title || "Untitled"}${loc ? ` @ ${loc}` : ""}${desc ? ` — ${desc}` : ""}`
}

// Grade one batch; returns batch-local 1-based index -> judgement. Retries on rate-limit with
// exponential backoff; throws if it ultimately fails so the caller can fail closed.
async function judgeBatch(prompt: string, events: WindowUniverseEvent[]): Promise<Map<number, Judgement>> {
  const list = events.map((e, i) => eventLine(e, i)).join("\n")
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { output } = await generateText({
        model: LABEL_MODEL,
        output: Output.object({ schema: judgeSchema }),
        system: RUBRIC,
        prompt: `USER REQUEST:\n"${prompt}"\n\nEVENTS (${events.length}):\n${list}\n\nScore every event.`,
        maxRetries: 3,
      })
      const map = new Map<number, Judgement>()
      for (const j of output.judgements) map.set(j.index, { score: j.score, reasoning: j.reasoning })
      return map
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rateLimited = /rate.?limit|429|too many|quota|overloaded|503/i.test(message)
      if (rateLimited && attempt < maxAttempts - 1) {
        const waitMs = 2000 * 2 ** attempt // 2s, 4s, 8s, 16s
        console.log(`[v0] labelBatch rate-limited, backing off ${waitMs}ms (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
  throw new Error("labelBatch exhausted retries")
}

// Label the whole universe with bounded concurrency. Returns id -> judgement plus the number of
// batches that failed after retries, so callers can fail closed rather than storing bogus 0-labels.
export async function labelUniverse(
  prompt: string,
  events: WindowUniverseEvent[],
): Promise<{ judgementById: Map<string, Judgement>; failedBatches: number }> {
  const batches: WindowUniverseEvent[][] = []
  for (let i = 0; i < events.length; i += JUDGE_BATCH) batches.push(events.slice(i, i + JUDGE_BATCH))

  const judgementById = new Map<string, Judgement>()
  let failedBatches = 0
  for (let i = 0; i < batches.length; i += JUDGE_CONCURRENCY) {
    const slice = batches.slice(i, i + JUDGE_CONCURRENCY)
    const results = await Promise.all(
      slice.map((b) =>
        judgeBatch(prompt, b)
          .then((m) => ({ ok: true as const, m }))
          .catch(() => ({ ok: false as const, m: new Map<number, Judgement>() })),
      ),
    )
    results.forEach((res, bi) => {
      if (!res.ok) {
        failedBatches++
        return // leave unscored; do NOT default to 0
      }
      const batch = slice[bi]
      batch.forEach((e, idx) => {
        const j = res.m.get(idx + 1)
        if (j) judgementById.set(e.id, j)
      })
    })
  }
  return { judgementById, failedBatches }
}
