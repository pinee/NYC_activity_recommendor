// Standalone retrieval dump: for each of the 20 NEW_EVAL_PROMPTS, embed the prompt with the
// production embedder (openai/text-embedding-3-small via the AI Gateway), rank the entire
// current 7-day event window with match_events (identical params to the production plan path),
// and emit the ranked event IDs sliced at k = 10, 20, 40, 80, 160.
//
// No recall, no LLM judge — pure retrieval output.
//
// Run:
//   npx tsx --env-file=/vercel/share/.env.project scripts/topk-events.ts
//
// Writes: scripts/out/topk-events.json  and  scripts/out/topk-events.csv

import { createClient } from "@supabase/supabase-js"
import { embed } from "ai"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const EMBEDDING_MODEL = "openai/text-embedding-3-small"
const K_VALUES = [10, 20, 40, 80, 160]
const MAX_K = Math.max(...K_VALUES)

// The 20 new benchmark prompts (kept in sync with NEW_EVAL_PROMPTS in lib/eval-prompts.ts).
const PROMPTS: string[] = [
  "I want to watch a movie outdoors tonight",
  "Are there any World Cup watch parties happening?",
  "I'm looking for yoga classes in Manhattan",
  "What art exhibitions or gallery events are happening this week?",
  "I want to go to a live jazz or music concert",
  "I want to do something active and energetic outdoors",
  "I'm looking for a quiet, intellectual evening",
  "I need something fun and family-friendly for the kids",
  "I want to feel connected to nature in the city",
  "I'm looking for a creative hands-on experience",
  "What free events are happening in Brooklyn?",
  "I want to do something fun in Queens",
  "What's happening at Bryant Park?",
  "I want to volunteer and give back to the community",
  "Find me something happening near the waterfront or by the water",
  "Something cultural and unique that most tourists wouldn't know about",
  "What's a good way to spend a summer evening in NYC?",
  "I want to learn something new this weekend",
  "Surprise me with something I probably haven't tried before",
  "I just want to get out of the house and do something fun",
]

// today 00:00 America/New_York -> +7 days, matching lib/eval/gold.ts weekWindow().
function nyToUtcISO(date: string, time: string): string {
  const [hh, mm] = (time || "00:00").split(":").map(Number)
  const [y, mo, d] = date.split("-").map(Number)
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm)
  const nyStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "America/New_York" })
  const utcStr = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" })
  const offsetMs = new Date(utcStr).getTime() - new Date(nyStr).getTime()
  return new Date(utcGuess + offsetMs).toISOString()
}

function weekWindow(): { start: string; end: string } {
  const todayNY = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 10)
  const start = nyToUtcISO(todayNY, "00:00")
  const end = new Date(new Date(start).getTime() + 7 * 86400000).toISOString()
  return { start, end }
}

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

// Returns the full window, ranked by cosine similarity — identical params to retrieveWindowUniverse().
async function rankedWindowIds(supabase: ReturnType<typeof createServiceClient>, queryEmbedding: number[]) {
  const { start, end } = weekWindow()
  const { data, error } = await supabase
    .rpc("match_events", {
      p_query_embedding: queryEmbedding,
      p_match_count: 5000, // > window size => returns everything, ranked
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
    .select("id")
  if (error) throw new Error(`match_events failed: ${error.message}`)
  return ((data as { id: string }[]) || []).map((r) => r.id).filter(Boolean)
}

async function main() {
  const supabase = createServiceClient()
  const { start, end } = weekWindow()
  console.log(`[v0] window ${start} -> ${end}`)

  type Row = {
    index: number
    prompt: string
    windowSize: number
    top10: string[]
    top20: string[]
    top40: string[]
    top80: string[]
    top160: string[]
  }
  const results: Row[] = []

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i]
    const emb = await embedQuery(prompt)
    const ranked = await rankedWindowIds(supabase, emb)
    const topN = (n: number) => ranked.slice(0, n)
    results.push({
      index: i + 1,
      prompt,
      windowSize: ranked.length,
      top10: topN(10),
      top20: topN(20),
      top40: topN(40),
      top80: topN(80),
      top160: topN(160),
    })
    console.log(`[v0] ${i + 1}/${PROMPTS.length} "${prompt.slice(0, 48)}" -> window=${ranked.length}`)
  }

  const outDir = join(process.cwd(), "scripts", "out")
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(outDir, "topk-events.json"), JSON.stringify({ window: { start, end }, results }, null, 2))

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
