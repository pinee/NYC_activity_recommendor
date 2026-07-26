// External ground-truth relevance set for the 20 NEW_EVAL_PROMPTS.
//
// For each prompt (keyed by its 1-based index in NEW_EVAL_PROMPTS), list the
// `events.id` (uuid) of every event YOU consider relevant. These come from your
// external "true" dataset — NOT from any LLM.
//
// scripts/recall-eval.ts computes recall@k (k = 10,20,40,80,160) by ranking the
// live 7-day window with the production embedder and intersecting the top-k ids
// with the relevant ids below.
//
// >>> FILL IN THE `relevantIds` ARRAYS BELOW. <<<

import { NEW_EVAL_PROMPTS } from "@/lib/eval-prompts"

export type RecallTruthEntry = {
  /** 1-based index into NEW_EVAL_PROMPTS (for readability / sanity checking). */
  index: number
  /** The prompt text (kept here only as a human-readable label). */
  prompt: string
  /** events.id uuids you consider relevant to this prompt. */
  relevantIds: string[]
}

export const RECALL_TRUTH: RecallTruthEntry[] = [
  { index: 1, prompt: "I want to watch a movie outdoors tonight", relevantIds: [] },
  { index: 2, prompt: "Are there any World Cup watch parties happening?", relevantIds: [] },
  { index: 3, prompt: "I'm looking for yoga classes in Manhattan", relevantIds: [] },
  { index: 4, prompt: "What art exhibitions or gallery events are happening this week?", relevantIds: [] },
  { index: 5, prompt: "I want to go to a live jazz or music concert", relevantIds: [] },
  { index: 6, prompt: "I want to do something active and energetic outdoors", relevantIds: [] },
  { index: 7, prompt: "I'm looking for a quiet, intellectual evening", relevantIds: [] },
  { index: 8, prompt: "I need something fun and family-friendly for the kids", relevantIds: [] },
  { index: 9, prompt: "I want to feel connected to nature in the city", relevantIds: [] },
  { index: 10, prompt: "I'm looking for a creative hands-on experience", relevantIds: [] },
  { index: 11, prompt: "What free events are happening in Brooklyn?", relevantIds: [] },
  { index: 12, prompt: "I want to do something fun in Queens", relevantIds: [] },
  { index: 13, prompt: "What's happening at Bryant Park?", relevantIds: [] },
  { index: 14, prompt: "I want to volunteer and give back to the community", relevantIds: [] },
  { index: 15, prompt: "Find me something happening near the waterfront or by the water", relevantIds: [] },
  { index: 16, prompt: "Something cultural and unique that most tourists wouldn't know about", relevantIds: [] },
  { index: 17, prompt: "What's a good way to spend a summer evening in NYC?", relevantIds: [] },
  { index: 18, prompt: "I want to learn something new this weekend", relevantIds: [] },
  { index: 19, prompt: "Surprise me with something I probably haven't tried before", relevantIds: [] },
  { index: 20, prompt: "I just want to get out of the house and do something fun", relevantIds: [] },
]

// Sanity: keep this file aligned with the prompt list.
if (RECALL_TRUTH.length !== NEW_EVAL_PROMPTS.length) {
  throw new Error(
    `RECALL_TRUTH has ${RECALL_TRUTH.length} entries but NEW_EVAL_PROMPTS has ${NEW_EVAL_PROMPTS.length}`,
  )
}
