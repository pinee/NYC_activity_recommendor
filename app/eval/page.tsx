"use client"

import { useState } from "react"
import { Loader2, Download, FlaskConical } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type EvalEvent = {
  rank: number
  id: string
  title: string
  description: string | null
  category: string | null
  start_time: string
  end_time: string | null
  venue_name: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  event_url: string | null
  source: string | null
  price: string | null
  image_url: string | null
  neighborhood: string | null
  approximate_location: boolean | null
  series_key: string | null
}

type EvalResult = {
  query: string
  scope: string
  matchCount: number
  returned: number
  generatedAt: string
  events: EvalEvent[]
}

// One curated pick from the LLM ranking stage (a subset of the Activity shape + rank).
type EvalActivity = {
  rank: number
  id: string
  title: string
  category: string
  date: string
  endDate?: string
  startTime: string
  endTime: string
  venue: string
  neighborhood: string
  address: string
  priceLabel: string
  url: string
  why: string
}

type LlmResult = {
  query: string
  generatedAt: string
  summary: string
  count: number
  activities: EvalActivity[]
}

// One judged event row (from the independent Claude judge) for the downloadable CSV.
type JudgedEvent = {
  rank: number
  id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  score: number
  relevant: boolean
}

type JudgeResult = {
  query: string
  judgeModel: string
  relevantThreshold: number
  generatedAt: string
  universeSize: number
  totalRelevant: number
  embedding: {
    recallAtK: { k: number; hits: number; recall: number | null }[]
    bestEventInclusion: { perfectCount: number; perfectInTop80: number; inclusionRate: number | null }
    diversity: {
      categoriesCovered: number
      universeCategories: number
      neighborhoodsCovered: number
      categoryEntropyNormalized: number
    }
  }
  llm: {
    picked: number
    relevant: number
    precision: number | null
    picks: { rank: number; id: string; title: string; category: string; score: number }[]
  }
  judged: JudgedEvent[]
}

const JUDGED_CSV_COLUMNS: (keyof JudgedEvent)[] = [
  "rank",
  "id",
  "title",
  "category",
  "venue_name",
  "neighborhood",
  "score",
  "relevant",
]

// Columns exported to CSV, in order.
const CSV_COLUMNS: (keyof EvalEvent)[] = [
  "rank",
  "id",
  "title",
  "category",
  "venue_name",
  "neighborhood",
  "address",
  "start_time",
  "end_time",
  "price",
  "source",
  "series_key",
  "event_url",
  "description",
]

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  // Escape per RFC 4180: wrap in quotes if it contains a comma, quote, or newline.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

// Columns exported for the LLM top-15 CSV, in order.
const ACTIVITY_CSV_COLUMNS: (keyof EvalActivity)[] = [
  "rank",
  "id",
  "title",
  "category",
  "date",
  "endDate",
  "startTime",
  "endTime",
  "venue",
  "neighborhood",
  "address",
  "priceLabel",
  "why",
  "url",
]

function toCsv<T>(rows: T[], columns: (keyof T)[]): string {
  const header = columns.join(",")
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))
  return [header, ...body].join("\r\n")
}

// Build a filesystem-friendly slug from the prompt for the download filename.
function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "prompt"
  )
}

function download(filename: string, content: string, type: string) {
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

export default function EvalPage() {
  const [query, setQuery] = useState("")
  const [matchCount, setMatchCount] = useState(80)
  const [scope, setScope] = useState<"week" | "all">("week")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<EvalResult | null>(null)
  const [llmLoading, setLlmLoading] = useState(false)
  const [llmResult, setLlmResult] = useState<LlmResult | null>(null)
  const [judgeLoading, setJudgeLoading] = useState(false)
  const [judgeResult, setJudgeResult] = useState<JudgeResult | null>(null)

  const run = async () => {
    if (!query.trim()) {
      toast.error("Enter a prompt first")
      return
    }
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/eval/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, matchCount, scope }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Retrieval failed")
        return
      }
      setResult(data as EvalResult)
      toast.success(`Retrieved ${data.returned} events`)
    } catch {
      toast.error("Request failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const runLlm = async () => {
    if (!query.trim()) {
      toast.error("Enter a prompt first")
      return
    }
    setLlmLoading(true)
    setLlmResult(null)
    try {
      const res = await fetch("/api/eval/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Curation failed")
        return
      }
      setLlmResult(data as LlmResult)
      toast.success(`LLM picked ${data.count} events`)
    } catch {
      toast.error("Request failed. Please try again.")
    } finally {
      setLlmLoading(false)
    }
  }

  const runJudge = async () => {
    if (!query.trim()) {
      toast.error("Enter a prompt first")
      return
    }
    setJudgeLoading(true)
    setJudgeResult(null)
    try {
      const res = await fetch("/api/eval/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Judge failed")
        return
      }
      setJudgeResult(data as JudgeResult)
      toast.success(`Judged ${data.universeSize} events`)
    } catch {
      toast.error("Request failed. Please try again.")
    } finally {
      setJudgeLoading(false)
    }
  }

  const downloadCsv = () => {
    if (!result) return
    download(
      `embeddings-${slug(result.query)}-top${result.returned}.csv`,
      toCsv(result.events, CSV_COLUMNS),
      "text/csv",
    )
  }

  const downloadJudgeCsv = () => {
    if (!judgeResult) return
    download(`judge-${slug(judgeResult.query)}.csv`, toCsv(judgeResult.judged, JUDGED_CSV_COLUMNS), "text/csv")
  }

  const downloadJudgeJson = () => {
    if (!judgeResult) return
    download(`judge-${slug(judgeResult.query)}.json`, JSON.stringify(judgeResult, null, 2), "application/json")
  }

  const downloadJson = () => {
    if (!result) return
    download(
      `embeddings-${slug(result.query)}-top${result.returned}.json`,
      JSON.stringify(result, null, 2),
      "application/json",
    )
  }

  const downloadLlmCsv = () => {
    if (!llmResult) return
    download(
      `llm-top15-${slug(llmResult.query)}.csv`,
      toCsv(llmResult.activities, ACTIVITY_CSV_COLUMNS),
      "text/csv",
    )
  }

  const downloadLlmJson = () => {
    if (!llmResult) return
    download(`llm-top15-${slug(llmResult.query)}.json`, JSON.stringify(llmResult, null, 2), "application/json")
  }

  return (
    <div className="min-h-svh">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-5 py-5 sm:px-8">
          <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-background">
            <FlaskConical className="size-4" />
          </div>
          <div className="leading-tight">
            <p className="font-mono text-sm font-bold uppercase tracking-widest">Embedding Eval</p>
            <p className="text-xs text-muted-foreground">Download top-K semantic matches per prompt</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8 sm:px-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold uppercase tracking-wide">Prompt</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. something chill and artsy after work in Brooklyn"
              rows={3}
              className="resize-y"
            />
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="matchCount" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Top K
                </Label>
                <Input
                  id="matchCount"
                  type="number"
                  min={1}
                  max={500}
                  value={matchCount}
                  onChange={(e) => setMatchCount(Number(e.target.value))}
                  className="w-28"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Scope</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as "week" | "all")}>
                  <SelectTrigger className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">Next 7 days (matches app)</SelectItem>
                    <SelectItem value="all">Whole catalog (eval-only, not app behavior)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button onClick={run} disabled={loading} variant="outline">
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Retrieving…
                    </>
                  ) : (
                    "Retrieve top-K (embeddings)"
                  )}
                </Button>
                <Button onClick={runLlm} disabled={llmLoading} variant="outline">
                  {llmLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Curating…
                    </>
                  ) : (
                    "Get LLM top 15"
                  )}
                </Button>
                <Button onClick={runJudge} disabled={judgeLoading}>
                  {judgeLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Judging…
                    </>
                  ) : (
                    "Judge with Claude"
                  )}
                </Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Runs the embedding stage only (embed prompt → <code>match_events</code>). Hard profile filters are left
              permissive so this measures the embedding model in isolation. Results are one row per logical event
              (deduped by <code>series_key</code>), ranked by cosine similarity.
            </p>
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                Results
                <Badge variant="secondary" className="font-normal">
                  {result.returned} events
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {result.scope === "all" ? "Whole catalog" : "Next 7 days"}
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadCsv}>
                  <Download className="size-4" /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={downloadJson}>
                  <Download className="size-4" /> JSON
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium">Venue</th>
                      <th className="px-3 py-2 font-medium">Start</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.events.map((e) => (
                      <tr key={e.id} className="border-t border-border align-top">
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">{e.rank}</td>
                        <td className="px-3 py-2">{e.title}</td>
                        <td className="px-3 py-2 text-muted-foreground">{e.category ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{e.venue_name ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {new Date(e.start_time).toLocaleString("en-US", {
                            timeZone: "America/New_York",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {llmResult && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                LLM top 15
                <Badge variant="secondary" className="font-normal">
                  {llmResult.count} events
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadLlmCsv}>
                  <Download className="size-4" /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={downloadLlmJson}>
                  <Download className="size-4" /> JSON
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                Runs the full production pipeline (filter → semantic fetch → <code>gpt-5-mini</code> curation),
                bypassing the plan cache so every click re-invokes the model. Because the model is not deterministic,
                the exact picks and ordering can vary between runs for the same prompt — run it a few times to gauge
                stability.
              </p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium">Venue</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmResult.activities.map((a) => (
                      <tr key={`${a.rank}-${a.id}`} className="border-t border-border align-top">
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">{a.rank}</td>
                        <td className="px-3 py-2">{a.title}</td>
                        <td className="px-3 py-2 text-muted-foreground">{a.category || "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{a.venue || "—"}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {a.date}
                          {a.endDate && a.endDate !== a.date ? ` → ${a.endDate}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {judgeResult && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                Judge scorecard
                <Badge variant="secondary" className="font-normal normal-case">
                  {judgeResult.judgeModel}
                </Badge>
                <Badge variant="outline" className="font-normal normal-case">
                  {judgeResult.totalRelevant} relevant / {judgeResult.universeSize} in window
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadJudgeCsv}>
                  <Download className="size-4" /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={downloadJudgeJson}>
                  <Download className="size-4" /> JSON
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <p className="rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                An independent model (<code>{judgeResult.judgeModel}</code>) graded every event in the next-7-day
                window 0–3 for relevance. Recall uses the full window as denominator (an event counts as relevant at
                score ≥ {judgeResult.relevantThreshold}). Precision@15 judges the real pipeline&apos;s LLM picks.
                Download the CSV to recompute metrics at any threshold.
              </p>

              {/* Embedding: recall@k */}
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Embedding recall@k
                </h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {judgeResult.embedding.recallAtK.map((r) => (
                    <div key={r.k} className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">recall@{r.k}</div>
                      <div className="text-xl font-semibold tabular-nums">
                        {r.recall === null ? "—" : `${(r.recall * 100).toFixed(1)}%`}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {r.hits}/{judgeResult.totalRelevant} relevant
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Embedding: best-event inclusion + diversity */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Best-event inclusion (top 80)
                  </div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {judgeResult.embedding.bestEventInclusion.inclusionRate === null
                      ? "—"
                      : `${(judgeResult.embedding.bestEventInclusion.inclusionRate * 100).toFixed(1)}%`}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {judgeResult.embedding.bestEventInclusion.perfectInTop80}/
                    {judgeResult.embedding.bestEventInclusion.perfectCount} perfect (score 3) events retrieved
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Top-80 diversity
                  </div>
                  <div className="mt-1 text-sm tabular-nums">
                    {judgeResult.embedding.diversity.categoriesCovered}/
                    {judgeResult.embedding.diversity.universeCategories} categories ·{" "}
                    {judgeResult.embedding.diversity.neighborhoodsCovered} neighborhoods
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    category entropy {(judgeResult.embedding.diversity.categoryEntropyNormalized * 100).toFixed(0)}%
                    (evenness)
                  </div>
                </div>
              </div>

              {/* LLM: precision@15 */}
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  LLM precision@15
                </h3>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xl font-semibold tabular-nums">
                    {judgeResult.llm.precision === null ? "—" : `${(judgeResult.llm.precision * 100).toFixed(1)}%`}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {judgeResult.llm.relevant}/{judgeResult.llm.picked} curated picks judged relevant
                  </div>
                  {judgeResult.llm.picks.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {judgeResult.llm.picks.map((p) => (
                        <li key={p.id} className="flex items-center gap-2 text-xs">
                          <Badge
                            variant={p.score >= judgeResult.relevantThreshold ? "secondary" : "outline"}
                            className="font-normal tabular-nums"
                          >
                            {p.score}
                          </Badge>
                          <span className="truncate">{p.title}</span>
                          <span className="text-muted-foreground">{p.category ? `· ${p.category}` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
