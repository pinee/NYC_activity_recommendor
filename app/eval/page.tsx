"use client"

import { useState } from "react"
import { Loader2, Download, FlaskConical } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"

// An event in the embedding model's top ranking, with the independent judge's score attached.
type TopEvent = {
  rank: number
  id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  score: number
  relevant: boolean
}

// A relevant event per Claude (with its position in the embedding ranking).
type RelevantEvent = {
  id: string
  title: string | null
  category: string | null
  venue_name: string | null
  neighborhood: string | null
  score: number
  rank: number | null
}

// recall@k at one cutoff.
type RecallAtK = {
  k: number
  captured: number
  recall: number | null
}

type RecallResult = {
  query: string
  judgeModel: string
  relevantThreshold: number
  kValues: number[]
  maxK: number
  generatedAt: string
  universeSize: number
  totalRelevant: number
  recallAtK: RecallAtK[]
  topEvents: TopEvent[]
  relevantEvents: RelevantEvent[]
  misses: RelevantEvent[]
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  // Escape per RFC 4180: wrap in quotes if it contains a comma, quote, or newline.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function toCsv<T>(rows: T[], columns: (keyof T)[]): string {
  const header = columns.join(",")
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))
  return [header, ...body].join("\r\n")
}

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

function scoreBadgeVariant(score: number, threshold: number): "secondary" | "outline" {
  return score >= threshold ? "secondary" : "outline"
}

// Smallest cutoff k that captures an event at the given embedding rank, or null if beyond all cutoffs.
function capturedAtK(rank: number | null, kValues: number[]): number | null {
  if (rank === null) return null
  const sorted = [...kValues].sort((a, b) => a - b)
  for (const k of sorted) if (rank <= k) return k
  return null
}

export default function EvalPage() {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RecallResult | null>(null)

  const run = async () => {
    if (!query.trim()) {
      toast.error("Enter a prompt first")
      return
    }
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/eval/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Eval failed")
        return
      }
      setResult(data as RecallResult)
      toast.success(`recall computed over ${data.universeSize} events`)
    } catch {
      toast.error("Request failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const downloadJson = () => {
    if (!result) return
    download(`recall-${slug(result.query)}.json`, JSON.stringify(result, null, 2), "application/json")
  }

  const downloadMissesCsv = () => {
    if (!result) return
    download(
      `recall-misses-${slug(result.query)}.csv`,
      toCsv(result.misses, ["rank", "id", "title", "category", "venue_name", "neighborhood", "score"]),
      "text/csv",
    )
  }

  return (
    <div className="min-h-svh">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-5 py-5 sm:px-8">
          <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-background">
            <FlaskConical className="size-4" />
          </div>
          <div className="leading-tight">
            <p className="font-mono text-sm font-bold uppercase tracking-widest">Recall@k Eval</p>
            <p className="text-xs text-muted-foreground">Embedding retrieval vs. an independent Claude judge</p>
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
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Embeds the prompt and retrieves the app&apos;s ranking via <code>match_events</code> (permissive
                filters = model in isolation), then has an independent Claude judge score every event in the
                next-7-day window and reports recall at k = 40, 80, and 160. This takes ~30–45s.
              </p>
              <Button onClick={run} disabled={loading} className="shrink-0">
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Computing…
                  </>
                ) : (
                  "Compute recall@k"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {result && (
          <>
            {/* Headline recall@k */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                  recall@k
                  <Badge variant="secondary" className="font-normal normal-case">
                    judge: {result.judgeModel}
                  </Badge>
                </CardTitle>
                <Button size="sm" variant="outline" onClick={downloadJson}>
                  <Download className="size-4" /> JSON
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {result.recallAtK.map((r) => (
                    <div key={r.k} className="rounded-lg border border-border p-4">
                      <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                        recall@{r.k}
                      </div>
                      <div className="mt-1 text-4xl font-semibold tabular-nums">
                        {r.recall === null ? "—" : `${(r.recall * 100).toFixed(1)}%`}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {r.captured} of {result.totalRelevant} relevant in top {r.k}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-8 text-sm">
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{result.universeSize}</div>
                    <div className="text-xs text-muted-foreground">events in window</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{result.totalRelevant}</div>
                    <div className="text-xs text-muted-foreground">relevant (Claude)</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{result.misses.length}</div>
                    <div className="text-xs text-muted-foreground">missed beyond top {result.maxK}</div>
                  </div>
                </div>
                <p className="rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  recall@k = relevant events inside the embedding&apos;s top k ÷ all relevant events in the window.
                  An event counts as relevant when Claude scores it ≥ {result.relevantThreshold} (0=irrelevant,
                  1=tangential, 2=relevant, 3=perfect).
                </p>
              </CardContent>
            </Card>

            {/* Side by side: embedding top ranking vs Claude relevant */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Embedding top 80 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                    Embedding top {result.maxK}
                    <Badge variant="secondary" className="font-normal">
                      {result.topEvents.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">#</th>
                          <th className="px-3 py-2 font-medium">Title</th>
                          <th className="px-3 py-2 font-medium">Category</th>
                          <th className="px-3 py-2 text-right font-medium">Judge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.topEvents.map((e) => (
                          <tr key={e.id} className="border-t border-border align-top">
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">{e.rank}</td>
                            <td className="px-3 py-2">
                              {e.title}
                              {e.venue_name ? (
                                <span className="block text-xs text-muted-foreground">{e.venue_name}</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{e.category ?? "—"}</td>
                            <td className="px-3 py-2 text-right">
                              <Badge
                                variant={scoreBadgeVariant(e.score, result.relevantThreshold)}
                                className="tabular-nums"
                              >
                                {e.score}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Claude relevant events */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                    Relevant per Claude
                    <Badge variant="secondary" className="font-normal">
                      {result.totalRelevant}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Title</th>
                          <th className="px-3 py-2 font-medium">Category</th>
                          <th className="px-3 py-2 text-right font-medium">Emb. rank</th>
                          <th className="px-3 py-2 text-right font-medium">Captured</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.relevantEvents.map((e) => (
                          <tr key={e.id} className="border-t border-border align-top">
                            <td className="px-3 py-2">
                              {e.title}
                              {e.venue_name ? (
                                <span className="block text-xs text-muted-foreground">{e.venue_name}</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{e.category ?? "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {e.rank ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {(() => {
                                const k = capturedAtK(e.rank, result.kValues)
                                return (
                                  <Badge variant={k === null ? "outline" : "secondary"} className="font-normal">
                                    {k === null ? "miss" : `≤${k}`}
                                  </Badge>
                                )
                              })()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Misses: relevant per Claude but not in top 80 */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                  Missed by embedding (relevant, outside top {result.maxK})
                  <Badge variant="secondary" className="font-normal">
                    {result.misses.length}
                  </Badge>
                </CardTitle>
                {result.misses.length > 0 && (
                  <Button size="sm" variant="outline" onClick={downloadMissesCsv}>
                    <Download className="size-4" /> CSV
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {result.misses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None — every event Claude judged relevant was captured within the top {result.maxK}.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Emb. rank</th>
                          <th className="px-3 py-2 font-medium">Title</th>
                          <th className="px-3 py-2 font-medium">Category</th>
                          <th className="px-3 py-2 font-medium">Venue</th>
                          <th className="px-3 py-2 text-right font-medium">Judge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.misses.map((e) => (
                          <tr key={e.id} className="border-t border-border align-top">
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">{e.rank ?? "—"}</td>
                            <td className="px-3 py-2">{e.title}</td>
                            <td className="px-3 py-2 text-muted-foreground">{e.category ?? "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{e.venue_name ?? "—"}</td>
                            <td className="px-3 py-2 text-right">
                              <Badge variant="secondary" className="tabular-nums">
                                {e.score}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  )
}
