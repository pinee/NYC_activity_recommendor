import { createServiceClient } from "@/lib/supabase/server"
import { embedQuery } from "@/lib/embeddings"
import { K_VALUES } from "@/lib/eval/gold"

// Evaluate one or more FROZEN gold sets. For each: re-embed the prompt with the app's embedding
// model, rank the frozen candidate snapshot via pgvector (match_gold_candidates), then compute
// recall@k against the AUDITED relevant set. Deterministic — no judge runs here.
export const maxDuration = 120

type RankedCandidate = {
  event_id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  judge_score: number | null
  judge_reasoning: string | null
  relevant: boolean
  distance: number
}

const MAX_K = Math.max(...K_VALUES)

async function evaluateOne(goldSetId: string) {
  const supabase = createServiceClient()

  const { data: gs, error: gsErr } = await supabase
    .from("eval_gold_sets")
    .select("id,prompt,status,judge_model,relevant_threshold,universe_size")
    .eq("id", goldSetId)
    .single()
  if (gsErr || !gs) return { goldSetId, error: gsErr?.message || "Gold set not found" }
  if (gs.status !== "frozen") return { goldSetId, prompt: gs.prompt, error: "Gold set is not frozen yet." }

  // Re-embed the prompt with the same model the app uses.
  const embedding = await embedQuery(gs.prompt)
  if (!embedding) return { goldSetId, prompt: gs.prompt, error: "Embedding failed (check AI Gateway credits)." }

  // Rank the FROZEN candidate corpus by cosine similarity to the query embedding.
  const { data, error } = await supabase.rpc("match_gold_candidates", {
    p_gold_set_id: goldSetId,
    p_query_embedding: embedding,
  })
  if (error) return { goldSetId, prompt: gs.prompt, error: error.message }

  const ranked = ((data as RankedCandidate[]) || []).map((c, i) => ({ ...c, rank: i + 1 }))
  const relevant = ranked.filter((c) => c.relevant)
  const totalRelevant = relevant.length

  const recallAtK = K_VALUES.map((k) => {
    const captured = relevant.filter((c) => c.rank <= k).length
    return { k, captured, recall: totalRelevant > 0 ? +(captured / totalRelevant).toFixed(4) : null }
  })

  // The frozen relevant set with each event's live embedding rank + whether it's captured by MAX_K.
  const relevantEvents = relevant
    .map((c) => ({
      event_id: c.event_id,
      title: c.title,
      category: c.category,
      venue_name: c.venue_name,
      neighborhood: c.neighborhood,
      judge_score: c.judge_score,
      judge_reasoning: c.judge_reasoning,
      rank: c.rank,
    }))
    .sort((a, b) => a.rank - b.rank)

  const misses = relevantEvents.filter((c) => c.rank > MAX_K)

  // Top MAX_K of the embedding ranking with labels attached (for inspection).
  const topEvents = ranked.slice(0, MAX_K).map((c) => ({
    rank: c.rank,
    event_id: c.event_id,
    title: c.title,
    category: c.category,
    venue_name: c.venue_name,
    neighborhood: c.neighborhood,
    judge_score: c.judge_score,
    relevant: c.relevant,
  }))

  return {
    goldSetId,
    prompt: gs.prompt,
    judgeModel: gs.judge_model,
    relevantThreshold: gs.relevant_threshold,
    universeSize: gs.universe_size,
    totalRelevant,
    recallAtK,
    topEvents,
    relevantEvents,
    misses,
  }
}

export async function POST(req: Request) {
  let body: { goldSetId?: string; goldSetIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const ids = body.goldSetIds?.length ? body.goldSetIds : body.goldSetId ? [body.goldSetId] : []
  if (ids.length === 0) return Response.json({ error: "Provide `goldSetId` or `goldSetIds`." }, { status: 400 })

  const results = []
  for (const id of ids) results.push(await evaluateOne(id))

  // Aggregate mean recall per k across successfully-evaluated sets (single benchmark number).
  const ok = results.filter((r) => !("error" in r && r.error)) as Extract<
    Awaited<ReturnType<typeof evaluateOne>>,
    { recallAtK: { k: number; recall: number | null }[] }
  >[]
  const aggregate = K_VALUES.map((k) => {
    const vals = ok
      .map((r) => r.recallAtK.find((x) => x.k === k)?.recall)
      .filter((v): v is number => typeof v === "number")
    const mean = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null
    return { k, mean, prompts: vals.length }
  })

  return Response.json({ kValues: K_VALUES, maxK: MAX_K, results, aggregate })
}
