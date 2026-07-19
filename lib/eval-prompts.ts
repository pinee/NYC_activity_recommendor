// Benchmark prompts for the embedding recall eval.
//
// Each entry simulates what a real user types into the app's free-text
// "what do you feel like doing" box. That text is embedded and fed to match_events —
// the exact retrieval path this eval measures — so these prompts ARE your test set.
//
// NOTE: the source list had exact duplicates ("I have $20 to spend tonight." and
// "I only have two hours after work." each appeared twice) which were removed. Entries
// 32-38 are shorter re-phrasings of earlier prompts (same intent, different wording) —
// kept because they embed differently, but you can trim them to save labeling cost.
export const EVAL_PROMPTS: string[] = [
  "I'm feeling burnt out after work. I want something relaxing tonight.",
  "Surprise me with something I probably wouldn't think of.",
  "I want to meet new people without feeling awkward.",
  "I want somewhere cozy where my friend and I can actually talk.",
  "I want to feel inspired and creative this weekend.",
  "I want an energetic night out, but not a club.",
  "I want to spend a slow Sunday doing something peaceful.",
  "I just moved to NYC. Help me fall in love with the city.",
  "I'm planning a first date tonight.",
  "My parents are visiting NYC. What should we do this afternoon?",
  "Three friends are meeting after work near Midtown.",
  "I'm spending Saturday alone and want to get out of the house.",
  "My partner and I want something different from our usual dinner date.",
  "We have a group of six people with mixed interests.",
  "I have $20 to spend tonight.",
  "Find me something completely free this weekend.",
  "I only have two hours after work.",
  "I don't want to travel more than 20 minutes from Chelsea.",
  "Find something that's open after 9 PM tonight.",
  "I have a car, so I'm willing to leave Manhattan.",
  "I love photography and visual arts.",
  "I'm looking for something related to books or writing.",
  "I want to discover a really good coffee event or tasting.",
  "I'm training for a marathon and want something fitness-related.",
  "I want to learn a new creative skill.",
  "I'm a huge soccer fan—what's happening this weekend?",
  "I don't know what I want. I just don't want to stay home tonight.",
  "Find me something fun that doesn't involve drinking.",
  "I don't like loud places or huge crowds.",
  "I want to feel like a tourist in my own city.",
  "Surprise me with something unusual.",
  "I want somewhere cozy where we can talk.",
  "I'm looking for photography-related activities.",
  "I want something free this weekend.",
  "My parents are visiting NYC.",
  "I don't like loud places.",
  "I want to meet new people.",
  "I don't know what I want.",
  "I want tonight to feel memorable.",
  "I need a change of scenery.",
  "Recommend something that will become a good story later.",
  "I want to get out of my comfort zone.",
  "What's happening tonight that most New Yorkers don't know about?",
]
