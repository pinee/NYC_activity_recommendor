import { createServiceClient } from "@/lib/supabase/server"

// List all gold sets with a relevant-count summary (for the Build/Audit picker).
export async function GET() {
  const supabase = createServiceClient()
  const { data: sets, error } = await supabase
    .from("eval_gold_sets")
    .select("id,prompt,status,judge_model,relevant_threshold,universe_size,created_at,labeled_at,frozen_at")
    .order("created_at", { ascending: false })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  const ids = (sets || []).map((s) => s.id)
  const relevantById = new Map<string, number>()
  if (ids.length > 0) {
    // Count relevant candidates per set without pulling vectors.
    const { data: rel, error: relErr } = await supabase
      .from("eval_gold_candidates")
      .select("gold_set_id")
      .eq("relevant", true)
      .in("gold_set_id", ids)
    if (relErr) return Response.json({ error: relErr.message }, { status: 500 })
    for (const r of (rel as { gold_set_id: string }[]) || []) {
      relevantById.set(r.gold_set_id, (relevantById.get(r.gold_set_id) ?? 0) + 1)
    }
  }

  const goldSets = (sets || []).map((s) => ({ ...s, relevantCount: relevantById.get(s.id) ?? 0 }))
  return Response.json({ goldSets })
}
