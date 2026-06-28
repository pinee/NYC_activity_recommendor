"use client"

import { useState } from "react"
import { Sparkles, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { SpecialRequest } from "@/lib/types"

interface Props {
  requests: SpecialRequest[]
  onAdd: (r: SpecialRequest) => void
  onRemove: (id: string) => void
}

const SUGGESTIONS = [
  "Need to meet a friend this Thursday evening",
  "Want one outdoor activity this weekend",
  "Find a date-night spot Friday",
  "Something free on a weeknight",
]

export function SpecialRequests({ requests, onAdd, onRemove }: Props) {
  const [text, setText] = useState("")

  const add = (value: string) => {
    const v = value.trim()
    if (!v) return
    onAdd({ id: `req-${Date.now()}`, text: v })
    setText("")
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        placeholder="Tell your concierge anything specific… e.g. I need to meet a friend this Thursday near Midtown."
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(text)
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
            >
              <Sparkles className="size-3 text-accent" /> {s}
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={() => add(text)} className="shrink-0">
          <Plus className="size-4" /> Add
        </Button>
      </div>

      {requests.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm"
            >
              <span className="leading-snug">{r.text}</span>
              <button
                type="button"
                onClick={() => onRemove(r.id)}
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label="Remove request"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
