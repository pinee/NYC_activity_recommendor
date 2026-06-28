# Architecture — NYC Activities

This document records the architecture-level choices made while building the app, and the reasoning ("why") behind each one. It complements `PRD.md` (what the app does) and `AI_CONTEXT.md` (the chronological history of decisions).

---

## 1. High-Level Shape

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Client)                        │
│                                                              │
│  app/page.tsx  ──────────────────────────────────────────┐  │
│   • Holds all app state (profile, calendar, weather,      │  │
│     requests, plan) in React state + localStorage         │  │
│   • Orchestrates fetches to the API routes                │  │
│                                                           │  │
│  Components: profile-form, calendar-panel, weather-strip, │  │
│  special-requests, weekly-plan, address-autocomplete      │  │
└───────────────┬───────────────────────────────────────────┘ │
                │ fetch()                                       │
┌───────────────▼───────────────────────────────────────────┐ │
│                  Next.js Route Handlers                     │ │
│                                                             │ │
│  /api/plan      → 2-step AI pipeline (research → structure) │ │
│  /api/weather   → Open-Meteo proxy (7-day NYC forecast)     │ │
│  /api/geocode   → Photon/OSM address autocomplete proxy     │ │
│  /api/google/*  → OAuth connect, callback, events, disconnect│ │
└───────────────┬───────────────────────────────────────────┘ │
                │                                               │
        ┌───────┴────────┬──────────────┬───────────────┐      │
        ▼                ▼              ▼               ▼      │
   AI Gateway       Open-Meteo      Photon/OSM     Google APIs  │
 (Perplexity +      (weather)       (geocoding)   (Calendar)    │
  OpenAI models)                                                │
```

**Why this shape:** A thin client that owns state, with stateless server route handlers that proxy/orchestrate third-party APIs. This keeps secrets server-side, avoids a database (per the "browser-only persistence" decision), and isolates each external dependency behind its own route so failures are contained.

---

## 2. Framework & Rendering

- **Next.js 16 App Router, React 19.** Default stack; no reason to deviate.
- **Client-heavy, not RSC-heavy.** The main page is a Client Component (`"use client"`) because it manages a lot of interactive, persisted state. There is no server-rendered data that benefits from RSC here — all dynamic data comes from user input or live API calls triggered by user actions.
- **No `runtime = "edge"` on API routes.** Required by the AI SDK; the plan route also needs a longer execution budget (`maxDuration = 120`) for live web search.

---

## 3. State & Persistence

- **Decision: browser-only persistence (localStorage), no database.**
  - Chosen explicitly by the user during the initial Q&A.
  - Implemented via a small `useLocalStorage` hook (`lib/use-local-storage.ts`) so each piece of profile/calendar/request state is individually persisted and rehydrated.
- **Why no database:** The app has a single user, no multi-device sync requirement, and no shared/social data. A DB would add setup, auth, and latency for no functional gain at this stage. (Documented as a known limitation / future upgrade path in the PRD.)
- **Trade-off:** Data is per-browser and clearable; OAuth tokens that ARE sensitive are kept server-side in httpOnly cookies, never in localStorage.

---

## 4. The Plan Pipeline (the heart of the app)

Located in `app/api/plan/route.ts`. **Two sequential AI calls**, not one:

1. **Research — `perplexity/sonar-pro`** (built-in live web search).
   - Returns free-text research notes + a list of citations (title + URL).
   - **Why Perplexity:** it has native, current web search. A plain LLM cannot find real, currently-scheduled events.
   - **Why `sonar-pro` over `sonar`:** we briefly switched to `sonar` for speed, but it returned wrong-city / aggregator sources that produced bad links. Accuracy of sources matters more than latency here, so we switched back. (See AI_CONTEXT for the full saga.)

2. **Structuring — `openai/gpt-5-mini`** with `Output.object()` (Zod schema).
   - Converts the messy research text into strict typed JSON.
   - **Why a second model/step:** separating "search the web" from "produce clean structured data" is more reliable than asking one model to do both. Perplexity is great at search but weaker at strict schema adherence; gpt-5-mini is fast and reliable at structured output.
   - **Why `Output.object()` (not `generateObject`):** `generateObject` is deprecated in AI SDK 6.
   - **Why minimal reasoning:** this step is pure reformatting, so reasoning effort is lowered to cut latency with negligible quality cost.

**Why two calls are kept despite latency:** the quality gain from specialization outweighs the cost, and we mitigate the latency with streaming + caching (below) rather than collapsing the steps.

---

## 5. Streaming & Progress

- **Decision: stream NDJSON status events from `/api/plan` instead of a single JSON response.**
  - The route emits `{type:"status"}` messages ("Searching live NYC listings…", "Organizing your week…", "Verifying event links…") then a final `{type:"result"}` or `{type:"error"}`.
  - The client reads the stream and updates a live progress label.
- **Why:** the pipeline takes tens of seconds. A single spinner for the full duration felt broken. Staged progress is the biggest *perceived*-latency win and required no quality trade-off.

---

## 6. Caching

- **Decision: in-memory cache keyed by (interests + addresses + week + requests), 30-min TTL.**
- **Why in-memory (not Redis/DB):** matches the no-database, single-user design; it's zero-setup and good enough to make repeat clicks instant.
- **Trade-off:** cache is per-server-instance and not shared/persistent. Acceptable for this app's scale; noted as a limitation.

---

## 7. Link Quality System (most-iterated subsystem)

This is the part with the most defensive engineering, because it caused the most real-world bugs (Google-search redirects, dead links, a Chicago events page for an NYC event).

The pipeline resolves and validates each event's link in layers:

1. **Source selection per activity:**
   - Use the model's URL if it's a real http(s) URL and **not a wrong-city page**.
   - Else fall back to `bestCitationFor()` — match the activity to a real Perplexity citation using **distinctive tokens only** (generic/temporal/location words are stripped to avoid false matches).
   - Prefer a **specific event/venue page**; allow a **NYC listing/calendar page only as a fallback** so the user always lands somewhere real.
2. **Hard rejects:**
   - `isWrongCityUrl()` — any path scoped to another major city (e.g. `/chicago/`) with no NYC marker is dropped. This was the direct fix for the Chicago bug.
   - `normalizeSourceUrl()` — prepends `https://` to bare domains and rejects non-URLs (fixed the `/barrys.com` 404).
   - **Never** emit a search-engine URL (we removed the old Google-search fallback entirely).
3. **Reachability check:** every surviving link is fetched in parallel (`isUrlReachable()`). Dead links (404/410/5xx, DNS/timeout) are dropped. Bot-block codes (401/403/405/429) are **kept**, because those pages load fine in a real browser — dropping them would be a false negative.
4. **Final rule:** an activity with **no usable link is dropped entirely.** Better to show fewer events than to show one the user can't act on.

**Why this layered approach:** each layer addresses a distinct failure mode discovered in testing. They are intentionally ordered cheap→expensive (string checks before network calls) and bias toward *dropping* questionable events rather than showing misleading ones — except where a strict rule would over-reject (hence the NYC-listing fallback and keeping bot-block codes).

---

## 8. Date Handling

- **Decision: anchor every activity to a real ISO date within the next 7 days, in `America/New_York`.**
  - `upcomingDates()` computes today + 6 days as `{iso, weekday, label}` in NYC time.
  - The schema requires an ISO `date`; the model is told to only use allowed dates and never a past date; the server filters out anything outside the window as a safeguard; results are sorted chronologically.
  - The UI groups by real date ("Wednesday · Jun 24"), not a fixed Mon→Sun order.
- **Why:** the original design used bare weekday names, which were ambiguous and surfaced already-passed days. Real dates are the only robust way to honor "only the next 7 days from today."
- **Why NYC timezone specifically:** the app is NYC-only and the server may run in any timezone; pinning to `America/New_York` keeps "today" correct for the user.

---

## 9. Interest Matching

- **Decision: strict relevance — only return activities that directly belong to a selected interest; return empty rather than padding.**
- Enforced in both AI steps (research prompt + structuring filter) **and** the UI (empty-state instead of an error).
- **Why:** the user explicitly rejected tangential suggestions (e.g. restaurants for a running search). Enforcing it at multiple layers (prompt + post-filter + UI) makes it robust to model drift.

---

## 10. Third-Party Integration Choices

| Need | Choice | Why |
|------|--------|-----|
| Activity discovery | Perplexity `sonar-pro` via AI Gateway | Native live web search |
| Structuring | OpenAI `gpt-5-mini` via AI Gateway | Fast, reliable structured output |
| Weather | Open-Meteo | Free, **no API key**, 7-day forecast |
| Address autocomplete | Photon (OpenStreetMap) | Free, **no API key**, real dropdown; avoids Google Places billing/key setup |
| Maps links | Google Maps URL scheme | No SDK/key needed — just a deep link from venue/address |
| Calendar | Google Calendar OAuth | The only input the user asked to import live |

**Cross-cutting why:** wherever possible we chose **key-less, zero-billing** providers (Open-Meteo, Photon, Maps deep links) to minimize setup friction. The two places that genuinely require credentials are the AI Gateway (the core feature) and Google Calendar (explicitly requested).

---

## 11. Auth / Secrets

- **Google OAuth tokens live in httpOnly cookies set by the server callback**, never exposed to client JS or localStorage.
- **All third-party calls that need secrets happen in route handlers**, so keys (`GOOGLE_CLIENT_SECRET`, `AI_GATEWAY_API_KEY`) never reach the browser.
- **Why cookies over localStorage for tokens:** httpOnly cookies are not readable by JS, mitigating XSS token theft.

---

## 12. Error Handling Strategy

- The plan route classifies errors and returns a typed `code`:
  - `billing` → missing payment method on the AI Gateway.
  - `rate_limit` → free-tier throttling (auto-retries can trip this).
  - `error` → everything else.
- The client shows a specific, actionable toast per code (longer duration for billing/rate-limit).
- **Why:** the generic "try again" message hid the real cause (which was account/billing config, not a code bug). Surfacing the precise reason is the difference between a user fixing it in 1 minute vs. being stuck.

---

## 13. Component Boundaries

- One concern per component: `profile-form`, `calendar-panel`, `weather-strip`, `special-requests`, `weekly-plan`, `address-autocomplete`.
- `page.tsx` is the single orchestrator/state owner; children are controlled via props + callbacks.
- **Why:** keeps each file small and focused, makes the data flow explicit (top-down state, bottom-up events), and avoids a monolithic page component.

---

## 14. Known Architectural Limitations (accepted, not bugs)

- **Free-tier AI rate limits** interrupt rapid back-to-back generations (mitigated by caching + clear messaging).
- **In-memory cache** is per-instance and non-persistent.
- **localStorage persistence** is per-browser, no sync.
- **Latency** is bounded by live web search; mitigated (streaming/caching) but not eliminated.

These are conscious trade-offs aligned with the single-user, no-database, fast-to-ship scope. Upgrade paths (DB, distributed cache, paid AI tier) are noted in `PRD.md`.
