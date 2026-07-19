"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2, Lock, Unlock, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Candidate, GoldSetSummary } from "@/app/eval/types"
import { fetcher } from "@/app/eval/types"

export function AuditSection({
  goldSets,
  refresh,
}: {
  goldSets: GoldSetSummary[]
  refresh: () => void
}) {
  const [selectedId, setSelectedId] = useState<string>("")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [freezing, setFreezing] = useState(false)
  // Only show events the judge rated at least tangential, unless "show all" is on.
  const [showAll, setShowAll] = useState(false)

  const selected = goldSets.find((g) => g.id === selectedId)
  const { data, isLoading, mutate } = useSWR<{ goldSet: GoldSetSummary; candidates: Candidate[] }>(
    selectedId ? `/api/eval/gold/${selectedId}` : null,
    fetcher,
  )

  // Reset local overrides whenever the loaded gold set changes.
  useEffect(() => {
    setOverrides({})
  }, [selectedId, data?.goldSet?.status])

  const candidates = data?.candidates ?? []
  const frozen = data?.goldSet?.status === "frozen"

  const relevantOf = (c: Candidate) => overrides[c.id] ?? c.relevant
  const dirtyCount = useMemo(
    () => candidates.filter((c) => overrides[c.id] !== undefined && overrides[c.id] !== c.relevant).length,
    [candidates, overrides],
  )
  const relevantCount = candidates.filter(relevantOf).length

  const visible = showAll ? candidates : candidates.filter((c) => (c.judge_score ?? 0) >= 1 || relevantOf(c))

  const toggle = (id: string, value: boolean) => setOverrides((o) => ({ ...o, [id]: value }))

  const saveLabels = async () => {
    const updates = candidates
      .filter((c) => overrides[c.id] !== undefined && overrides[c.id] !== c.relevant)
      .map((c) => ({ candidateId: c.id, relevant: overrides[c.id] }))
    if (updates.length === 0) {
      toast.info("No label changes to save.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/eval/gold/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateLabels", updates }),
      })
      const d = await res.json()
      if (!res.ok) {
        toast.error(d.error || "Save failed")
        return
      }
      toast.success(`Saved ${d.updated} label change(s)`)
      setOverrides({})
      mutate()
      refresh()
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (action: "freeze" | "reopen") => {
    if (dirtyCount > 0) {
      toast.error("Save your label changes before changing status.")
      return
    }
    setFreezing(true)
    try {
      const res = await fetch(`/api/eval/gold/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const d = await res.json()
      if (!res.ok) {
        toast.error(d.error || "Action failed")
        return
      }
      toast.success(action === "freeze" ? "Gold set frozen" : "Gold set reopened")
      mutate()
      refresh()
    } finally {
      setFreezing(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        <div>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide">Audit &amp; freeze</CardTitle>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Review Sonnet&apos;s calls, override any you disagree with, then freeze. Frozen sets are the
            immutable ground truth used for recall. Relevant = judge score 3 by default.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedId} onValueChange={(v) => setSelectedId(v ?? "")}>
            <SelectTrigger className="w-full sm:w-[420px]">
              <SelectValue placeholder="Select a gold set to audit…" />
            </SelectTrigger>
            <SelectContent>
              {goldSets.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  [{g.status}] {g.prompt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <Badge variant={frozen ? "default" : "secondary"} className="font-normal">
              {frozen ? "frozen" : "draft"}
            </Badge>
          )}
        </div>
      </CardHeader>

      {selectedId && (
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading candidates…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4 text-sm">
                  <span>
                    <span className="font-semibold tabular-nums">{relevantCount}</span>{" "}
                    <span className="text-muted-foreground">relevant</span>
                  </span>
                  <span className="text-muted-foreground">/ {candidates.length} judged</span>
                  {dirtyCount > 0 && (
                    <Badge variant="outline" className="font-normal">
                      {dirtyCount} unsaved
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={showAll} onCheckedChange={setShowAll} />
                    Show irrelevant (score 0)
                  </label>
                  <Button size="sm" variant="outline" onClick={saveLabels} disabled={frozen || saving || dirtyCount === 0}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save labels
                  </Button>
                  {frozen ? (
                    <Button size="sm" variant="outline" onClick={() => setStatus("reopen")} disabled={freezing}>
                      {freezing ? <Loader2 className="size-4 animate-spin" /> : <Unlock className="size-4" />} Reopen
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setStatus("freeze")} disabled={freezing || dirtyCount > 0}>
                      {freezing ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />} Freeze
                    </Button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Event</th>
                      <th className="px-3 py-2 text-center font-medium">Score</th>
                      <th className="px-3 py-2 font-medium">Judge reasoning</th>
                      <th className="px-3 py-2 text-right font-medium">Relevant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => (
                      <tr key={c.id} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{c.title || "Untitled"}</div>
                          <div className="text-xs text-muted-foreground">
                            {[c.category, c.venue_name, c.neighborhood].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Badge
                            variant={(c.judge_score ?? 0) >= 3 ? "default" : "secondary"}
                            className="font-normal tabular-nums"
                          >
                            {c.judge_score ?? "—"}
                          </Badge>
                        </td>
                        <td className="max-w-md px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                          {c.judge_reasoning || "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Switch
                            checked={relevantOf(c)}
                            onCheckedChange={(v) => toggle(c.id, v)}
                            disabled={frozen}
                            aria-label={`Mark ${c.title || "event"} relevant`}
                          />
                        </td>
                      </tr>
                    ))}
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                          No candidates to show.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
