// Standalone retrieval dump against a FIXED, frozen event universe.
//
// Instead of re-querying the live 7-day window (which drifts run-to-run and applies per-query
// series de-duplication), this ranks each of the 20 benchmark prompts against a fixed set of
// event IDs supplied in scripts/data/universe-617.csv. For every prompt we:
//   1. embed the prompt with the production embedder (openai/text-embedding-3-small),
//   2. compute cosine similarity against each fixed event's STORED embedding vector,
//   3. rank descending and slice at k = 10, 20, 40, 80, 160.
//
// This makes the candidate set identical for every prompt and reproducible across runs, and
// guarantees every emitted ID is one of the fixed universe IDs.
//
// No recall, no LLM judge — pure retrieval output.
//
// Run:
//   npx tsx --env-file=/vercel/share/.env.project scripts/topk-events.ts
//
// Writes: scripts/out/topk-events.json  and  scripts/out/topk-events.csv

import { createClient } from "@supabase/supabase-js"
import { embed } from "ai"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

const EMBEDDING_MODEL = "openai/text-embedding-3-small"
const K_VALUES = [10, 20, 40, 80, 160]
const MAX_K = Math.max(...K_VALUES)
const UNIVERSE_CSV = join(process.cwd(), "scripts", "data", "universe-617.csv")

// The 20 benchmark prompts (kept in sync with NEW_EVAL_PROMPTS in lib/eval-prompts.ts).
const PROMPTS: string[] = [
  "I want to watch a movie outdoors tonight",
  "I'm looking for yoga or meditation classes",
  "What live music or concerts are happening this week?",
  "Are there any workshops where I can learn a craft?",
  "I want to take my kids to something fun this week",
  "I want to do something active and energetic outdoors",
  "I'm looking for a quiet, intellectual evening",
  "I want to feel connected to nature in the city",
  "I'm looking for a creative hands-on experience",
  "I want a relaxing, low-key evening after a stressful week",
  "What's happening at Bryant Park this week?",
  "Find me free fitness classes I can join",
  "I want to volunteer and give back to the community",
  "What's happening near the waterfront or by the river?",
  "Find me something happening in Prospect Park or Brooklyn parks",
  "Something cultural and unique that most tourists wouldn't know about",
  "What's a good way to spend a summer evening in NYC?",
  "I want to learn something new this weekend",
  "Surprise me with something I probably haven't tried before",
  "I just want to get out of the house and do something fun",
]

function createServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: EMBEDDING_MODEL, value: text.slice(0, 6000), maxRetries: 4 })
  return embedding
}

// pgvector comes back from PostgREST as a JSON-ish string "[0.1,0.2,...]"; normalize to number[].
function parseEmbedding(raw: unknown): number[] | null {
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

// Minimal RFC-4180 CSV parser (handles quoted fields with embedded commas, quotes, and newlines).
// Returns an array of records, each an array of string fields.
function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      record.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      record.push(field)
      records.push(record)
      field = ""
      record = []
    } else {
      field += c
    }
  }
  // flush trailing field/record if the file doesn't end with a newline
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

// Read the fixed universe CSV and return the ordered list of event IDs (first column, minus header).
function loadUniverseIds(): string[] {
  const raw = readFileSync(UNIVERSE_CSV, "utf8")
  const rows = parseCsv(raw)
  if (rows.length === 0) throw new Error("universe CSV is empty")
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idCol = header.indexOf("event_id")
  if (idCol === -1) throw new Error("universe CSV missing 'event_id' column")
  const ids: string[] = []
  const seen = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const id = (rows[i][idCol] || "").trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

// Fetch stored embedding vectors for the given IDs. Chunked to stay under PostgREST URL limits.
async function fetchEmbeddings(
  supabase: ReturnType<typeof createServiceClient>,
  ids: string[],
): Promise<Map<string, number[]>> {
  const byId = new Map<string, number[]>()
  const ID_CHUNK = 100
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await supabase.from("events").select("id,embedding").in("id", chunk)
    if (error) throw new Error(`embedding fetch failed: ${error.message}`)
    for (const r of (data as { id: string; embedding: unknown }[]) || []) {
      const v = parseEmbedding(r.embedding)
      if (v) byId.set(r.id, v)
    }
  }
  return byId
}

// Cosine similarity between two equal-length vectors.
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function main() {
  const supabase = createServiceClient()

  const universeIds = loadUniverseIds()
  console.log(`[v0] fixed universe: ${universeIds.length} event IDs from universe-617.csv`)

  const embById = await fetchEmbeddings(supabase, universeIds)
  const withEmb = universeIds.filter((id) => embById.has(id))
  const missing = universeIds.filter((id) => !embById.has(id))
  console.log(`[v0] embeddings found for ${withEmb.length}/${universeIds.length} events`)
  if (missing.length > 0) {
    console.log(`[v0] WARNING: ${missing.length} universe IDs have no stored embedding and are excluded:`)
    missing.forEach((id) => console.log(`      - ${id}`))
  }

  // Freeze the candidate matrix once: the ordered ids + their vectors.
  const candidates = withEmb.map((id) => ({ id, vec: embById.get(id)! }))

  type Row = {
    index: number
    prompt: string
    universeSize: number
    top10: string[]
    top20: string[]
    top40: string[]
    top80: string[]
    top160: string[]
  }
  const results: Row[] = []

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i]
    const q = await embedQuery(prompt)
    const ranked = candidates
      .map((c) => ({ id: c.id, score: cosine(q, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.id)
    const topN = (n: number) => ranked.slice(0, n)
    results.push({
      index: i + 1,
      prompt,
      universeSize: candidates.length,
      top10: topN(10),
      top20: topN(20),
      top40: topN(40),
      top80: topN(80),
      top160: topN(160),
    })
    console.log(`[v0] ${i + 1}/${PROMPTS.length} "${prompt.slice(0, 48)}" -> ranked ${ranked.length}`)
  }

  const outDir = join(process.cwd(), "scripts", "out")
  mkdirSync(outDir, { recursive: true })

  writeFileSync(
    join(outDir, "topk-events.json"),
    JSON.stringify(
      { universeSize: candidates.length, missingEmbeddings: missing, kValues: K_VALUES, results },
      null,
      2,
    ),
  )

  // Long CSV: one row per (prompt, rank) up to MAX_K so any cutoff can be sliced downstream.
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const lines = ["prompt_index,prompt,rank,event_id"]
  for (const r of results) {
    r.top160.forEach((id, idx) => {
      lines.push(`${r.index},${esc(r.prompt)},${idx + 1},${id}`)
    })
  }
  writeFileSync(join(outDir, "topk-events.csv"), lines.join("\n"))

  console.log(`[v0] wrote ${results.length} prompts (top-${MAX_K}) to scripts/out/`)
}

main().catch((e) => {
  console.error("[v0] failed:", e)
  process.exit(1)
})
