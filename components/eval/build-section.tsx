"use client"

import { useState } from "react"
import { Loader2, Hammer, Check, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EVAL_PROMPTS } from "@/lib/eval-prompts"
import type { GoldSetSummary } from "@/app/eval/types"

export function BuildSection({
  goldSets,
  refresh,
}: {
  goldSets: GoldSetSummary[]
  refresh: () => void
}) {
  const [busyPrompt, setBusyPrompt] = useState<string | null>(null)
  const [buildingAll, setBuildingAll] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // Map prompt -> its most recent gold set (if any).
  const byPrompt = new Map<string, GoldSetSummary>()
  for (const gs of goldSets) if (!byPrompt.has(gs.prompt)) byPrompt.set(gs.prompt, gs)

  const labelOne = async (prompt: string): Promise<boolean> => {
    const res = await fetch("/api/eval/gold/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error || "Labeling failed", { description: prompt })
      return false
    }
    toast.success(`Labeled "${prompt}"`, {
      description: `${data.relevantCount} relevant of ${data.universeSize} events`,
    })
    return true
  }

  const buildOne = async (prompt: string) => {
    setBusyPrompt(prompt)
    try {
      if (await labelOne(prompt)) refresh()
    } finally {
      setBusyPrompt(null)
    }
  }

  const buildAll = async () => {
    // Only build prompts that don't already have a gold set.
    const todo = EVAL_PROMPTS.filter((p) => !byPrompt.has(p))
    if (todo.length === 0) {
      toast.info("All prompts already have gold sets.")
      return
    }
    setBuildingAll(true)
    setProgress({ done: 0, total: todo.length })
    try {
      for (let i = 0; i < todo.length; i++) {
        await labelOne(todo[i])
        setProgress({ done: i + 1, total: todo.length })
        refresh()
      }
      toast.success("Finished building gold sets.")
    } finally {
      setBuildingAll(false)
      setProgress(null)
    }
  }

  const remove = async (id: string, prompt: string) => {
    const res = await fetch(`/api/eval/gold/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const d = await res.json()
      toast.error(d.error || "Delete failed")
      return
    }
    toast.success(`Deleted gold set for "${prompt}"`)
    refresh()
  }

  const anyBusy = buildingAll || busyPrompt !== null

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide">Build gold sets</CardTitle>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Each prompt is a query a user would type. Labeling embeds it, snapshots the 7-day event window
            (text + vectors), and has Sonnet score every event. Edit the list in{" "}
            <code>lib/eval-prompts.ts</code>.
          </p>
        </div>
        <Button onClick={buildAll} disabled={anyBusy} className="shrink-0">
          {buildingAll ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {progress ? `Building ${progress.done}/${progress.total}…` : "Building…"}
            </>
          ) : (
            <>
              <Hammer className="size-4" /> Build all missing
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {EVAL_PROMPTS.map((prompt) => {
            const gs = byPrompt.get(prompt)
            const busy = busyPrompt === prompt
            return (
              <li key={prompt} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{prompt}</p>
                  {gs ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {gs.status === "frozen" ? "Frozen" : "Draft"} · {gs.relevantCount} relevant ·{" "}
                      {gs.universe_size} events
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted-foreground">Not labeled yet</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {gs ? (
                    <>
                      <Badge variant={gs.status === "frozen" ? "default" : "secondary"} className="font-normal">
                        {gs.status === "frozen" ? (
                          <>
                            <Check className="mr-1 size-3" /> frozen
                          </>
                        ) : (
                          "draft"
                        )}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(gs.id, prompt)}
                        disabled={anyBusy}
                        aria-label={`Delete gold set for ${prompt}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => buildOne(prompt)} disabled={anyBusy}>
                      {busy ? <Loader2 className="size-4 animate-spin" /> : "Label"}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
