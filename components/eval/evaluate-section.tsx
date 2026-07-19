"use client"

import { useState } from "react"
import { Loader2, Play, Download, ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import type { EvalResult, EvaluateResponse, GoldSetSummary } from "@/app/eval/types"
import { download, pct, slug, toCsv } from "@/app/eval/types"

const HEADLINE_K = 80

export function EvaluateSection({ goldSets }: { goldSets: GoldSetSummary[] }) {
  const frozen = goldSets.filter((g) => g.status === "frozen")
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<EvaluateResponse | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const selectedIds = frozen.filter((g) => selected[g.id]).map((g) => g.id)
  const allSelected = frozen.length > 0 && selectedIds.length === frozen.length

  const toggleAll = () => {
    if (allSelected) setSelected({})
    else setSelected(Object.fromEntries(frozen.map((g) => [g.id, true])))
  }

  const run = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one frozen gold set.")
      return
    }
    setLoading(true)
    setResponse(null)
    try {
      const res = await fetch("/api/eval/gold/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goldSetIds: selectedIds }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Evaluation failed")
        return
      }
      setResponse(data)
      toast.success(`Evaluated ${selectedIds.length} gold set(s)`)
    } finally {
      setLoading(false)
    }
  }

  const headlineAggregate = response?.aggregate.find((a) => a.k === HEADLINE_K)

  const downloadJson = () => {
    if (!response) return
    download(`recall-eval-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(response, null, 2), "application/json")
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-sm font-semibold uppercase tracking-wide">Evaluate</CardTitle>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Re-embeds each prompt and ranks its frozen corpus — deterministic, no judge calls.
              recall@{HEADLINE_K} is the production number (the app feeds its top 80 to the LLM).
            </p>
          </div>
          <Button onClick={run} disabled={loading || selectedIds.length === 0} className="shrink-0">
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Evaluating…
              </>
            ) : (
              <>
                <Play className="size-4" /> Run recall ({selectedIds.length})
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent>
          {frozen.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No frozen gold sets yet. Build and freeze at least one in the other tabs.
            </p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Frozen gold sets ({frozen.length})
                </span>
                <Button size="sm" variant="ghost" onClick={toggleAll}>
                  {allSelected ? "Clear all" : "Select all"}
                </Button>
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {frozen.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-4 py-2.5">
                    <label className="flex min-w-0 items-center gap-3">
                      <Switch
                        checked={!!selected[g.id]}
                        onCheckedChange={(v) => setSelected((s) => ({ ...s, [g.id]: v }))}
                        aria-label={`Select ${g.prompt}`}
                      />
                      <span className="truncate text-sm">{g.prompt}</span>
                    </label>
                    <span className="shrink-0 text-xs text-muted-foreground">{g.relevantCount} relevant</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {response && (
        <>
          {/* Aggregate headline across selected prompts */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide">
                Benchmark — mean recall
              </CardTitle>
              <Button size="sm" variant="outline" onClick={downloadJson}>
                <Download className="size-4" /> JSON
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
                <div>
                  <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    mean recall@{HEADLINE_K}
                  </div>
                  <div className="mt-1 text-5xl font-semibold tabular-nums">{pct(headlineAggregate?.mean)}</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    across {headlineAggregate?.prompts ?? 0} prompt(s)
                  </div>
                </div>
                <div className="flex gap-8 text-sm">
                  {response.aggregate
                    .filter((a) => a.k !== HEADLINE_K)
                    .map((a) => (
                      <div key={a.k}>
                        <div className="text-2xl font-semibold tabular-nums">{pct(a.mean)}</div>
                        <div className="text-xs text-muted-foreground">mean recall@{a.k}</div>
                      </div>
                    ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Per-prompt results */}
          {response.results.map((r) => (
            <PerPromptResult
              key={r.goldSetId}
              result={r}
              expanded={!!expanded[r.goldSetId]}
              onToggle={() => setExpanded((e) => ({ ...e, [r.goldSetId]: !e[r.goldSetId] }))}
            />
          ))}
        </>
      )}
    </div>
  )
}

function PerPromptResult({
  result: r,
  expanded,
  onToggle,
}: {
  result: EvalResult
  expanded: boolean
  onToggle: () => void
}) {
  if (r.error) {
    return (
      <Card>
        <CardContent className="py-4">
          <p className="text-sm font-medium">{r.prompt || r.goldSetId}</p>
          <p className="mt-1 text-sm text-destructive">{r.error}</p>
        </CardContent>
      </Card>
    )
  }

  const headline = r.recallAtK?.find((x) => x.k === HEADLINE_K)

  const downloadMisses = () => {
    download(
      `recall-misses-${slug(r.prompt || "")}.csv`,
      toCsv(r.misses ?? [], ["rank", "event_id", "title", "category", "venue_name", "neighborhood", "judge_score", "judge_reasoning"]),
      "text/csv",
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm font-semibold">{r.prompt}</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {r.totalRelevant} relevant · {r.universeSize} in window · judge {r.judgeModel}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onToggle}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Details
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {r.recallAtK?.map((x) => (
            <div
              key={x.k}
              className={
                "rounded-lg border p-4 " + (x.k === HEADLINE_K ? "border-foreground/40 bg-muted/40" : "border-border")
              }
            >
              <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                recall@{x.k}
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{pct(x.recall)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {x.captured} of {r.totalRelevant} in top {x.k}
              </div>
            </div>
          ))}
        </div>

        {expanded && (
          <div className="flex flex-col gap-5">
            {/* Relevant events with their live embedding rank */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Relevant events (by embedding rank)
                </h4>
                {(r.misses?.length ?? 0) > 0 && (
                  <Button size="sm" variant="outline" onClick={downloadMisses}>
                    <Download className="size-4" /> Misses CSV
                  </Button>
                )}
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 text-right font-medium">Emb. rank</th>
                      <th className="px-3 py-2 text-right font-medium">In top {HEADLINE_K}?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.relevantEvents ?? []).map((e) => (
                      <tr key={e.event_id} className="border-t border-border">
                        <td className="px-3 py-2">{e.title || "Untitled"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{e.category || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{e.rank}</td>
                        <td className="px-3 py-2 text-right">
                          <Badge variant={e.rank <= HEADLINE_K ? "secondary" : "outline"} className="font-normal">
                            {e.rank <= HEADLINE_K ? "yes" : "miss"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
