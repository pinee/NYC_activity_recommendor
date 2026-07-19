// Shared client types + helpers for the gold-set eval UI.

export type GoldSetSummary = {
  id: string
  prompt: string
  status: "draft" | "frozen"
  judge_model: string | null
  relevant_threshold: number
  universe_size: number
  created_at: string
  labeled_at: string | null
  frozen_at: string | null
  relevantCount: number
}

export type Candidate = {
  id: string
  event_id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  description: string | null
  judge_score: number | null
  judge_reasoning: string | null
  relevant: boolean
}

export type RecallAtK = { k: number; captured: number; recall: number | null }

export type EvalTopEvent = {
  rank: number
  event_id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  judge_score: number | null
  relevant: boolean
}

export type EvalRelevantEvent = {
  event_id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  judge_score: number | null
  judge_reasoning: string | null
  rank: number
}

export type EvalResult = {
  goldSetId: string
  prompt?: string
  judgeModel?: string | null
  relevantThreshold?: number
  universeSize?: number
  totalRelevant?: number
  recallAtK?: RecallAtK[]
  topEvents?: EvalTopEvent[]
  relevantEvents?: EvalRelevantEvent[]
  misses?: EvalRelevantEvent[]
  error?: string
}

export type EvaluateResponse = {
  kValues: number[]
  maxK: number
  results: EvalResult[]
  aggregate: { k: number; mean: number | null; prompts: number }[]
}

export const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`
}

// CSV helpers (RFC 4180).
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv<T>(rows: T[], columns: (keyof T)[]): string {
  const header = columns.join(",")
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))
  return [header, ...body].join("\r\n")
}

export function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "prompt"
  )
}

export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
