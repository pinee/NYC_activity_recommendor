// Benchmark prompts for the embedding recall eval.
//
// Each entry simulates what a real user types into the app's free-text
// "what do you feel like doing" box. That text is embedded and fed to match_events —
// the exact retrieval path this eval measures — so these prompts ARE your test set.
//
// >>> REPLACE THESE PLACEHOLDERS WITH YOUR OWN PROMPTS. <<<
// Aim for prompts that reflect how your users actually phrase requests, covering the
// range of intents/vibes/locations you care about. Add or remove freely.
export const EVAL_PROMPTS: string[] = [
  "something chill and artsy after work in Brooklyn",
  "live jazz in a cozy bar downtown",
  "free outdoor activities this weekend with kids",
  "high-energy nightlife and dancing in Manhattan",
  "a quiet museum or gallery afternoon",
  "hands-on workshop or class to learn something new",
  "romantic date night ideas near the water",
  "cheap eats and food markets in Queens",
]
