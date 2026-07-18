import { embed, embedMany } from "ai"

// Semantic-search embedding model, served through the Vercel AI Gateway (OpenAI is a
// zero-config provider). 1536 dims — MUST match the vector(1536) column defined in the
// Supabase migration and the match_events() function.
export const EMBEDDING_MODEL = "openai/text-embedding-3-small"
export const EMBEDDING_DIMS = 1536

// The fields that describe an event well enough for "what do you feel like doing" search.
// We deliberately include category/venue/neighborhood so a query like "cozy jazz bar in
// Brooklyn" can match on vibe, genre, AND location, not just the title.
export function eventEmbeddingText(e: {
  title?: string | null
  category?: string | null
  venue_name?: string | null
  neighborhood?: string | null
  borough?: string | null
  description?: string | null
  tags?: string[] | null
}): string {
  const parts = [
    e.title,
    e.category,
    e.venue_name,
    [e.neighborhood, e.borough].filter(Boolean).join(", "),
    (e.tags ?? []).join(", "),
    e.description,
  ]
    .map((p) => (p || "").trim())
    .filter(Boolean)
  // Cap length so an unusually long description can't blow past the model's token budget.
  return parts.join("\n").slice(0, 6000)
}

// Embed a single free-text query (the user's description of what they feel like doing).
// Returns null on failure so callers can gracefully fall back to keyword matching.
export async function embedQuery(text: string): Promise<number[] | null> {
  const value = (text || "").trim()
  if (!value) return null
  try {
    const { embedding } = await embed({ model: EMBEDDING_MODEL, value: value.slice(0, 6000) })
    return embedding
  } catch (err) {
    console.log("[v0] embedQuery failed:", err instanceof Error ? err.message : err)
    return null
  }
}

// Embed many event texts at once (used at ingest / backfill). Returns embeddings aligned
// to the input order, or null on failure so the caller can skip this batch and retry later.
export async function embedEventTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const { embeddings } = await embedMany({ model: EMBEDDING_MODEL, values: texts })
    return embeddings
  } catch (err) {
    console.log("[v0] embedEventTexts failed:", err instanceof Error ? err.message : err)
    return null
  }
}
