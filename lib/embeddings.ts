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
//
// The AI Gateway FREE TIER rate-limits embedding requests aggressively, so a single
// transient 429 shouldn't kill the request. We retry with exponential backoff on
// rate-limit errors (and let the SDK's maxRetries handle transient network blips)
// before giving up.
export async function embedQuery(text: string): Promise<number[] | null> {
  const value = (text || "").trim()
  if (!value) return null
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { embedding } = await embed({
        model: EMBEDDING_MODEL,
        value: value.slice(0, 6000),
        maxRetries: 4,
      })
      return embedding
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A 402 / "positive credit balance" is a billing issue — retrying never helps, so bail fast.
      if (isCreditError(message)) {
        console.log("[v0] embedQuery failed (billing):", message)
        return null
      }
      const rateLimited = /rate.?limit|429|too many|quota/i.test(message)
      if (rateLimited && attempt < maxAttempts - 1) {
        // 2s, 4s, 8s, 16s — enough to clear the free-tier per-minute window.
        const waitMs = 2000 * 2 ** attempt
        console.log(`[v0] embedQuery rate-limited, backing off ${waitMs}ms (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      console.log("[v0] embedQuery failed:", message)
      return null
    }
  }
  return null
}

// True when an AI Gateway error is due to an exhausted credit balance (HTTP 402). These are
// billing failures that no amount of retrying will fix — the user must add credits.
export function isCreditError(message: string): boolean {
  return /402|positive credit balance|add credits|payment required|insufficient/i.test(message)
}

// Embed many event texts at once (used at ingest / backfill). Returns embeddings aligned
// to the input order, or null on failure so the caller can skip this batch and retry later.
//
// The AI Gateway FREE TIER rate-limits embedding requests aggressively (a few per minute),
// so we retry with exponential backoff on the "rate-limited" / 429 error before giving up.
// `maxRetries: 4` lets the SDK also handle transient network errors.
export async function embedEventTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { embeddings } = await embedMany({ model: EMBEDDING_MODEL, values: texts, maxRetries: 4 })
      return embeddings
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rateLimited = /rate.?limit|429|too many|quota/i.test(message)
      if (rateLimited && attempt < maxAttempts - 1) {
        // 4s, 8s, 16s, 32s — long enough to clear the free-tier per-minute window.
        const waitMs = 4000 * 2 ** attempt
        console.log(`[v0] embed rate-limited, backing off ${waitMs}ms (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      console.log("[v0] embedEventTexts failed:", message)
      return null
    }
  }
  return null
}
