import { createServiceClient } from "@/lib/supabase/server"
import { embedQuery } from "@/lib/embeddings"
import {
  LABEL_MODEL,
  RELEVANT_THRESHOLD,
  labelUniverse,
  retrieveWindowUniverse,
  weekWindow,
} from "@/lib/eval/gold"

// Build ONE draft gold set for a single prompt: snapshot the windowed corpus (event fields +
// embedding vectors) and have Sonnet label every event with a score + reasoning. The UI loops
// this over the prompt list so each request stays well under maxDuration and progress is visible.
export const maxDuration = 300

export async function POST(req: Request) {
  let body: { prompt?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const prompt = (body.prompt || "").trim()
  if (!prompt) return Response.json({ error: "Provide a non-empty `prompt`." }, { status: 400 })

  // 1) Embed the prompt with the SAME model the app uses.
  const embedding = await embedQuery(prompt)
  if (!embedding) {
    return Response.json(
      {
        error:
          "Embedding request failed. The most common cause is an exhausted AI Gateway credit balance " +
          "(HTTP 402) — add credits in your Vercel project's AI settings and retry.",
      },
      { status: 502 },
    )
  }

  // 2) Retrieve the full windowed universe + freeze each event's embedding vector.
  let universe
  try {
    universe = await retrieveWindowUniverse(embedding)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Retrieval failed" }, { status: 500 })
  }
  if (universe.length === 0) return Response.json({ error: "No events in the window." }, { status: 404 })

  const missingVectors = universe.filter((e) => !e.embedding).length
  if (missingVectors === universe.length) {
    return Response.json({ error: "No embedding vectors available to freeze." }, { status: 500 })
  }

  // 3) Label the whole universe with Sonnet (score + reasoning). Fail closed on partial failure.
  const { judgementById, failedBatches } = await labelUniverse(prompt, universe)
  if (failedBatches > 0) {
    return Response.json(
      {
        error: `Labeling model rate-limited: ${failedBatches} batch(es) failed after retries. No gold set was created — please retry in a minute.`,
      },
      { status: 502 },
    )
  }

  // 4) Persist the draft gold set + its frozen candidates.
  const supabase = createServiceClient()
  const { start, end } = weekWindow()
  const { data: gs, error: gsErr } = await supabase
    .from("eval_gold_sets")
    .insert({
      prompt,
      status: "draft",
      judge_model: LABEL_MODEL,
      relevant_threshold: RELEVANT_THRESHOLD,
      window_start: start,
      window_end: end,
      universe_size: universe.length,
      labeled_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (gsErr || !gs) {
    return Response.json({ error: gsErr?.message || "Failed to create gold set" }, { status: 500 })
  }

  const rows = universe.map((e) => {
    const j = judgementById.get(e.id)
    const score = j?.score ?? 0
    return {
      gold_set_id: gs.id,
      event_id: e.id,
      title: e.title,
      category: e.category,
      venue_name: e.venue_name,
      neighborhood: e.neighborhood,
      description: e.description,
      embedding: e.embedding, // number[] → vector(1536)
      judge_score: score,
      judge_reasoning: j?.reasoning ?? null,
      relevant: score >= RELEVANT_THRESHOLD, // strict default; human-editable in audit
    }
  })

  // Insert in chunks to keep payloads reasonable (vectors are large).
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: insErr } = await supabase.from("eval_gold_candidates").insert(rows.slice(i, i + CHUNK))
    if (insErr) {
      // Roll back the partially-created set so we never leave a corrupt gold set behind.
      await supabase.from("eval_gold_sets").delete().eq("id", gs.id)
      return Response.json({ error: `Failed to store candidates: ${insErr.message}` }, { status: 500 })
    }
  }

  const relevantCount = rows.filter((r) => r.relevant).length
  return Response.json({
    id: gs.id,
    prompt,
    universeSize: universe.length,
    relevantCount,
    missingVectors,
    judgeModel: LABEL_MODEL,
  })
}
