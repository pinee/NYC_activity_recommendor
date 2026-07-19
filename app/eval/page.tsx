"use client"

import { useState } from "react"
import { Loader2, Download, FlaskConical } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"

// An event in the embedding model's top 80, with the independent judge's score attached.
type Top80Event = {
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
  inTop80: boolean
}

type RecallResult = {
  query: string
  judgeModel: string
  relevantThreshold: number
  topK: number
  generatedAt: string
  universeSize: number
  totalRelevant: number
  capturedInTop80: number
  recallAt80: number | null
  top80: Top80Event[]
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
      toast.success(`recall@80 computed over ${data.universeSize} events`)
    } catch {
      toast.error("Request failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const downloadJson = () => {
    if (!result) return
    download(`recall80-${slug(result.query)}.json`, JSON.stringify(result, null, 2), "application/json")
  }

  const downloadMissesCsv = () => {
    if (!result) return
    download(
      `recall80-misses-${slug(result.query)}.csv`,
      toCsv(result.misses, ["rank", "id", "title", "category", "venue_name", "neighborhood", "score"]),
      "text/csv",
    )
  }

  const recallPct = result?.recallAt80 === null || result?.recallAt80 === undefined ? null : result.recallAt80 * 100

  return (
    <div className="min-h-svh">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-5 py-5 sm:px-8">
          <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-background">
            <FlaskConical className="size-4" />
          </div>
          <div className="leading-tight">
            <p className="font-mono text-sm font-bold uppercase tracking-widest">Recall@80 Eval</p>
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
                Embeds the prompt and retrieves the app&apos;s top 80 via <code>match_events</code> (permissive
                filters = model in isolation), then has an independent judge (<code>claude-sonnet-4.6</code>) score
                every event in the next-7-day window. This takes ~30–45s.
              </p>
              <Button onClick={run} disabled={loading} className="shrink-0">
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Computing…
                  </>
                ) : (
                  "Compute recall@80"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {result && (
          <>
            {/* Headline recall@80 */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                  recall@80
                  <Badge variant="secondary" className="font-normal normal-case">
                    judge: {result.judgeModel}
                  </Badge>
                </CardTitle>
                <Button size="sm" variant="outline" onClick={downloadJson}>
                  <Download className="size-4" /> JSON
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
                  <div>
                    <div className="text-5xl font-semibold tabular-nums">
                      {recallPct === null ? "—" : `${recallPct.toFixed(1)}%`}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {result.capturedInTop80} of {result.totalRelevant} relevant events captured in top 80
                    </div>
                  </div>
                  <div className="flex gap-8 text-sm">
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
                      <div className="text-xs text-muted-foreground">missed by top 80</div>
                    </div>
                  </div>
                </div>
                <p className="rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  recall@80 = relevant events inside the embedding&apos;s top 80 ÷ all relevant events in the window.
                  An event counts as relevant when Claude scores it ≥ {result.relevantThreshold} (0=irrelevant,
                  1=tangential, 2=relevant, 3=perfect).
                </p>
              </CardContent>
            </Card>

            {/* Side by side: embedding top 80 vs Claude relevant */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Embedding top 80 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                    Embedding top 80
                    <Badge variant="secondary" className="font-normal">
                      {result.top80.length}
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
                        {result.top80.map((e) => (
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
                          <th className="px-3 py-2 text-right font-medium">In 80?</th>
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
                              <Badge variant={e.inTop80 ? "secondary" : "outline"} className="font-normal">
                                {e.inTop80 ? "yes" : "no"}
                              </Badge>
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
                  Missed by embedding (relevant, outside top 80)
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
                    None — every event Claude judged relevant was captured within the top 80.
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
