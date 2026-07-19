"use client"

import useSWR from "swr"
import { FlaskConical } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { BuildSection } from "@/components/eval/build-section"
import { AuditSection } from "@/components/eval/audit-section"
import { EvaluateSection } from "@/components/eval/evaluate-section"
import type { GoldSetSummary } from "./types"
import { fetcher } from "./types"

export default function EvalPage() {
  const { data, mutate, isLoading } = useSWR<{ goldSets: GoldSetSummary[] }>("/api/eval/gold", fetcher)
  const goldSets = data?.goldSets ?? []
  const frozenCount = goldSets.filter((g) => g.status === "frozen").length
  const refresh = () => mutate()

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
          <FlaskConical className="size-5" />
        </div>
        <div>
          <p className="font-mono text-sm font-bold uppercase tracking-widest">Embedding Recall Benchmark</p>
          <p className="text-xs text-muted-foreground">
            Frozen, audited gold sets · recall@80 = the app&apos;s production retrieval ceiling
          </p>
        </div>
      </header>

      <section className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        Your app embeds a user&apos;s free-text request and feeds the top 80 <code>match_events</code>{" "}
        results to the LLM. This benchmark reproduces that exact path: a strong independent judge (Sonnet)
        labels every event in the window once, you audit and freeze the labels, then recall is computed
        deterministically — so the number reflects the embedding model, not judge noise.
      </section>

      <Tabs defaultValue="build" className="w-full">
        <TabsList>
          <TabsTrigger value="build">
            Build
            {goldSets.length > 0 && (
              <Badge variant="secondary" className="ml-2 font-normal">
                {goldSets.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="evaluate">
            Evaluate
            {frozenCount > 0 && (
              <Badge variant="secondary" className="ml-2 font-normal">
                {frozenCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="mt-4">
          <BuildSection goldSets={goldSets} refresh={refresh} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditSection goldSets={goldSets} refresh={refresh} />
        </TabsContent>
        <TabsContent value="evaluate" className="mt-4">
          <EvaluateSection goldSets={goldSets} />
        </TabsContent>
      </Tabs>

      {isLoading && <p className="text-center text-sm text-muted-foreground">Loading gold sets…</p>}
    </main>
  )
}
