import { createServiceClient } from "@/lib/supabase/server"

// GET one gold set with its candidates (no vectors — too large) for auditing.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createServiceClient()

  const { data: gs, error: gsErr } = await supabase.from("eval_gold_sets").select("*").eq("id", id).single()
  if (gsErr || !gs) return Response.json({ error: gsErr?.message || "Not found" }, { status: 404 })

  const { data: candidates, error: cErr } = await supabase
    .from("eval_gold_candidates")
    .select("id,event_id,title,category,venue_name,neighborhood,description,judge_score,judge_reasoning,relevant")
    .eq("gold_set_id", id)
    .order("judge_score", { ascending: false })
    .order("title", { ascending: true })
  if (cErr) return Response.json({ error: cErr.message }, { status: 500 })

  return Response.json({ goldSet: gs, candidates: candidates || [] })
}

// PATCH: audit actions.
//   { action: "updateLabels", updates: [{ candidateId, relevant }] } — human overrides
//   { action: "freeze" } — lock the gold set (only after auditing)
//   { action: "reopen" } — set back to draft for further edits
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: {
    action?: string
    updates?: { candidateId?: string; relevant?: boolean }[]
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const supabase = createServiceClient()

  const { data: gs, error: gsErr } = await supabase
    .from("eval_gold_sets")
    .select("id,status")
    .eq("id", id)
    .single()
  if (gsErr || !gs) return Response.json({ error: gsErr?.message || "Not found" }, { status: 404 })

  if (body.action === "updateLabels") {
    if (gs.status === "frozen") {
      return Response.json({ error: "Gold set is frozen. Reopen it before editing labels." }, { status: 409 })
    }
    const updates = (body.updates || []).filter((u) => u.candidateId && typeof u.relevant === "boolean")
    if (updates.length === 0) return Response.json({ error: "No valid updates provided." }, { status: 400 })
    // Apply each override (scoped to this gold set so IDs can't cross sets).
    for (const u of updates) {
      const { error } = await supabase
        .from("eval_gold_candidates")
        .update({ relevant: u.relevant })
        .eq("id", u.candidateId as string)
        .eq("gold_set_id", id)
      if (error) return Response.json({ error: error.message }, { status: 500 })
    }
    return Response.json({ updated: updates.length })
  }

  if (body.action === "freeze") {
    const { error } = await supabase
      .from("eval_gold_sets")
      .update({ status: "frozen", frozen_at: new Date().toISOString() })
      .eq("id", id)
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ status: "frozen" })
  }

  if (body.action === "reopen") {
    const { error } = await supabase
      .from("eval_gold_sets")
      .update({ status: "draft", frozen_at: null })
      .eq("id", id)
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ status: "draft" })
  }

  return Response.json({ error: "Unknown action." }, { status: 400 })
}

// DELETE a gold set (candidates cascade).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createServiceClient()
  const { error } = await supabase.from("eval_gold_sets").delete().eq("id", id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ deleted: true })
}
