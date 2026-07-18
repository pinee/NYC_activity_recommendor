import { createServiceClient } from "@/lib/supabase/server"
import { eventEmbeddingText, embedEventTexts } from "@/lib/embeddings"

// How many events to embed per embedMany() call. Keeps each request comfortably within the
// model's batch/token limits while still amortizing latency across many events.
const EMBED_BATCH = 96

// Compute and store embeddings for up to `limit` events that don't have one yet (newly
// ingested rows, or older rows being backfilled). Idempotent and resumable: each call drains
// part of the backlog and reports how many events still lack an embedding, so a backfill
// caller can loop until `remaining` reaches 0. Embeddings are written in a SEPARATE update
// pass (never as part of the ingest upsert) so existing embeddings are always preserved.
export async function embedMissingEvents(limit: number): Promise<{ embedded: number; remaining: number }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("events")
    .select("id,title,category,venue_name,neighborhood,borough,description,tags")
    .is("embedding", null)
    .limit(limit)
  if (error) throw new Error(error.message)

  const rows = data ?? []
  let embedded = 0

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const chunk = rows.slice(i, i + EMBED_BATCH)
    const texts = chunk.map((r) => eventEmbeddingText(r))
    const vectors = await embedEventTexts(texts)
    if (!vectors) continue // batch failed (e.g. rate limit) — leave these for a later run

    await Promise.all(
      chunk.map((r, idx) =>
        supabase
          .from("events")
          // pgvector expects the text literal form "[1,2,3]" — stringify the JS array.
          .update({ embedding: JSON.stringify(vectors[idx]) })
          .eq("id", r.id),
      ),
    )
    embedded += chunk.length
  }

  const { count } = await supabase
    .from("events")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)

  return { embedded, remaining: count ?? 0 }
}
