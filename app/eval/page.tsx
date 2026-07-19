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

function toCsv(events: EvalEvent[]): string {
  const header = CSV_COLUMNS.join(",")
  const rows = events.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","))
  return [header, ...rows].join("\r\n")
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

  const downloadCsv = () => {
    if (!result) return
    download(`embeddings-${slug(result.query)}-top${result.returned}.csv`, toCsv(result.events), "text/csv")
  }

  const downloadJson = () => {
    if (!result) return
    download(
      `embeddings-${slug(result.query)}-top${result.returned}.json`,
      JSON.stringify(result, null, 2),
      "application/json",
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
                    <SelectItem value="week">Next 7 days (production)</SelectItem>
                    <SelectItem value="all">Whole catalog</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={run} disabled={loading} className="ml-auto">
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Retrieving…
                  </>
                ) : (
                  "Retrieve matches"
                )}
              </Button>
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
      </main>
    </div>
  )
}
