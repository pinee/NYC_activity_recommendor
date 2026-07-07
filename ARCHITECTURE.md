# Architecture — NYC Activities

This document records the architecture-level choices in the app and the reasoning ("why")
behind each one. It complements `PRD.md` (what the app does) and `AI_CONTEXT.md` (the
chronological history of decisions).

> **Major architectural shift:** the app was originally a *live web search on every request*
> (Perplexity `sonar-pro` to find events + `gpt-5-mini` to structure them). It is now a
> **catalog-backed** system: a daily cron ingests real NYC events from ~24 sources into a
> Supabase database, and each request *reads and curates* that catalog. This eliminated
> dead/hallucinated links, cut latency and cost, and made results reproducible. Everything
> below reflects the current, catalog-backed design.

---

## 1. High-Level Shape

```
                    ┌───────────────────────────────────────────┐
   Daily 08:00 UTC  │            Vercel Cron (vercel.json)        │
   ───────────────► │        GET /api/cron/ingest (maxDur 300)    │
                    │  • pull ~24 EventSources (RSS/HTML/Tribe)   │
                    │  • dedupe, reclassify World Cup, geocode    │
                    │  • upsert into Supabase, delete finished    │
                    │  • write ingestion_logs audit row           │
                    └───────────────────┬─────────────────────────┘
                                        │ upsert/delete (service role)
                                        ▼
                              ┌────────────────────┐
                              │  Supabase Postgres  │
                              │  events (catalog)   │
                              │  ingestion_logs     │
                              └─────────┬───────────┘
                                        │ read (service role)
┌─────────────────────────────┐        │
│        Browser (Client)      │        │
│  app/page.tsx owns state +   │        │
│  localStorage; components:   │        │
│  profile-form, calendar,     │        │
│  weather-strip, requests,    │        │
│  weekly-plan, worldcup-spots │        │
└──────────────┬───────────────┘        │
               │ fetch()                 │
┌──────────────▼─────────────────────────▼───────────────────────┐
│                     Next.js Route Handlers                       │
│  /api/plan     → read catalog → AI curate by id → det. filters   │
│  /api/worldcup → aggregate World Cup viewing into spots          │
│  /api/weather  → Open-Meteo proxy (7-day NYC forecast)           │
│  /api/geocode  → Photon/OSM address autocomplete proxy           │
│  /api/google/* → OAuth connect, callback, events, disconnect     │
└──────────────┬───────────────────────────────────────────────────┘
               │
   ┌───────────┼─────────────┬───────────────┬──────────────┐
   ▼           ▼             ▼               ▼              ▼
AI Gateway  Open-Meteo   Photon/OSM     US Census      Google APIs
(gpt-5-mini (weather)   (autocomplete)  Geocoder       (Calendar)
 curation)                              (travel coords)
```

**Why this shape:** separating **ingestion** (slow, scheduled, write-heavy) from **serving**
(fast, on-demand, read-only) is the core decision. It makes the user-facing request cheap and
reliable, isolates flaky third-party feeds to a background job, and guarantees every link is a
real source URL rather than something a model produced live.

---

## 2. Framework & Rendering

- **Next.js 16 App Router, React 19.** Default stack; no reason to deviate.
- **Client-heavy main page.** `app/page.tsx` is a Client Component because it manages a lot of
  interactive, persisted state; all dynamic data comes from user input or API calls.
- **Route-level execution budgets:** `/api/cron/ingest` sets `maxDuration = 300` (it fans out to
  ~24 feeds + geocoding); `/api/plan` uses `maxDuration = 60`; `/api/worldcup` `30`.

---

## 3. Data Model & Persistence

- **Decision: a shared Supabase Postgres catalog for events; browser-only for user profile.**
  - `public.events` is the activity catalog; `public.ingestion_logs` audits each ingest run.
  - The event schema is mirrored by `NormalizedEvent` (`lib/event-sources/types.ts`) so every
    source produces the exact column shape the ingest upsert expects.
  - **Deterministic primary key:** `id` is a UUID derived by hashing `source + source event id`
    (`deterministicId` in `util.ts`). Re-ingesting the same event yields the same id, so an
    upsert on the PK naturally de-duplicates across daily runs — no separate dedupe table.
  - **RLS:** both tables are public-read; all writes happen server-side with the **service role**
    key (which bypasses RLS) in the cron job. The service client (`lib/supabase/server.ts`) is
    server-only and must never be imported into a Client Component.
- **Why a database now (vs. the old no-DB design):** a shared, pre-built catalog is what makes
  reads fast and links trustworthy. The events are the same for everyone, so they belong in
  shared storage, not per-request live search.
- **Why the profile stays in `localStorage`:** it's single-user, private, and needs no sync.
  Google OAuth tokens (which *are* sensitive) live in httpOnly cookies, never localStorage.

---

## 4. Ingestion Pipeline (`app/api/cron/ingest/route.ts`)

Runs daily at 08:00 UTC via Vercel Cron. Per run:

1. **Fetch all enabled sources.** Each `EventSource` (in `lib/event-sources/`) implements a
   common interface returning `NormalizedEvent[]` for a horizon window. A **failing source is
   logged and skipped** so one bad feed never fails the whole run.
2. **De-dup within the batch** by deterministic id.
3. **Reclassify World Cup viewing.** Soccer/World Cup viewing events arrive under many source
   categories; `isWorldCupViewing()` detects genuine *viewing* events and re-stamps them with a
   single canonical category (`WORLD_CUP_CATEGORY`), preserving the original in `tags`.
4. **Enrich coordinates.** Events missing lat/lng are geocoded (US Census Geocoder), **capped at
   80 per run** so one ingest can't fan out into hundreds of requests. Bare venue/neighborhood
   geocodes are flagged `approximate_location`.
5. **Upsert** on the PK (refreshes existing rows instead of duplicating), stamping
   `last_updated` and `status: "active"`.
6. **Delete truly-finished events** (end_time in the past, or no end_time and start in the past),
   anchored to the start of today NY-time so ongoing multi-day events survive.
7. **Audit:** open an `ingestion_logs` row at start, update it with success counts or the error.

- **Horizon = 14 days** (the app shows 7; the extra buffer keeps the rolling window full between
  daily runs).
- **Auth:** `CRON_SECRET` bearer check. Vercel Cron sends it automatically; if unset (local/dev)
  the endpoint is open.
- **Extensibility:** add a source by implementing `EventSource` in its own file and registering it
  in `lib/event-sources/index.ts`. Sites on the "The Events Calendar" (Tribe) WordPress plugin
  reuse `createTribeSource` (`tribe.ts`), which several sources (SummerStage, Prospect Park,
  Green-Wood, Poster House, Flatiron/NoMad) share.

**Why a scheduled batch:** feeds are slow, occasionally broken, and identical for all users.
Doing this work once a day in the background — rather than on every user request — is the single
biggest reliability and latency win in the app.

---

## 5. The Plan Pipeline (`app/api/plan/route.ts`)

The heart of the serving path. **No live web search** — it reads the catalog and curates it.

1. **Read + pre-filter (SQL).** `fetchUpcomingEvents()` selects events whose span overlaps the
   next 7 days (NY time), including ongoing multi-day events, and **pre-filters to the user's
   interests** via `INTEREST_KEYWORDS` category matching. Special cases, all combined in one
   `.or()`:
   - **"Festivals & fireworks"** additionally matches on the event **title** (holiday events are
     categorized by activity type, not the holiday name).
   - **"Others"** is a catch-all: a nested negation over the whole keyword universe, matching
     events that match no other interest.
   - Single-day events that already started earlier today are dropped in JS; multi-day events stay
     visible for their whole run.
2. **AI curation (best-effort).** `openai/gpt-5-mini` with `Output.object()` (Zod schema) and
   **minimal reasoning** picks the best events **by id only** and adds soft metadata (indoor guess,
   neighborhood, travel note, one-line "why"). It is explicitly forbidden from inventing events,
   dates, links, or venues.
   - **Why AI can't invent anything:** the DB owns title/date/url/price; the model just ranks and
     annotates. This is what structurally guarantees link quality and date accuracy.
   - **Graceful fallback:** if the model is unavailable (e.g. rate-limited), a deterministic
     interest match serves the catalog directly, so the DB can always produce a plan on its own.
3. **Merge:** DB fields are authoritative (title/date/url/price/image); model metadata fills
   why/travel/neighborhood/indoor.
4. **Deterministic filters** (applied after curation, see §6).
5. **Sort, cap (`MAX_ACTIVITIES = 15`), and build a de-duplicated Sources list.**

---

## 6. Deterministic Constraint Filters

Hard constraints are enforced in code, *not* left to the model, so they're reliable:

- **Budget:** `parsePriceUSD()` extracts the cheapest dollar figure from the free-text price;
  dropped only when a parsed price exceeds the cap (free/$25/$75/none). Unknown/free always pass.
- **Working hours:** events starting within the user's working hours on a working day are dropped.
- **Travel:** home/office are geocoded once (`geo.ts`, cached); each event's straight-line
  Haversine distance is converted to estimated minutes (detour factor + blended city speed). An
  event is dropped only when both an origin and an event coordinate exist **and** the closer of
  home/office exceeds the max-travel preference.
- **Approximate location:** if the user opts out, events flagged `approximate_location` are dropped
  (their travel times can't be trusted).
- A **`filteredNote`** reports how many events were hidden and why.

**Why deterministic:** these are objective, user-set limits. Enforcing them in code (after the AI
has chosen *relevant* events) is more trustworthy than asking a model to respect numeric limits.

---

## 7. Date Handling

- **Anchor everything to `America/New_York`.** "Today" and the 7-day window are computed in NY time
  regardless of server timezone; `nyToUtcISO`/`nyParts`/`nyDateOf`/`nyClockOf` convert between
  stored UTC timestamps and NY-local dates/times.
- **Ongoing multi-day events** that began before today are anchored to "today" for display and get a
  "Runs through …" range label; single-day events show a start (and end) clock time only on their
  actual day.
- **Defensive window filter:** even after the SQL query, results are filtered to the valid ISO date
  set before rendering.
- **Why:** NYC-only app on servers of unknown timezone — pinning to NY time is the only robust way
  to honor "only the next 7 days from today" and to avoid surfacing already-passed events.

---

## 8. World Cup & Soccer (location-first sub-feature)

- **Decision: present soccer/World Cup *viewing* as places, not a day-by-day itinerary.** Fans know
  match times; what they need is *where* to watch.
- At **ingest**, viewing events are re-stamped with one canonical category (§4.3) so they collect
  under a single interest and are not double-listed under "Sports & games".
- `lib/worldcup.ts` fetches the **entire** tournament's viewing events (not just the 7-day window),
  aggregates sessions into **one entry per venue** with a date span and session count, and adds
  best-effort (informational only) travel estimates. It is **not** filtered by budget/hours/travel.
- Shared by both `/api/plan` (when the interest is selected) and the standalone `/api/worldcup`
  browse endpoint, so the two always agree. Rendered by `worldcup-spots.tsx`.

---

## 9. Streaming & Caching

- **NDJSON status stream** from `/api/plan`: emits `{type:"status"}` messages ("Reading the latest
  NYC events…", "Organizing your week…") then a final `{type:"result"}` or `{type:"error"}`. The
  client updates a live progress label. **Why:** perceived-latency win with no quality trade-off.
- **In-memory cache**, keyed by (interests + addresses + week + requests + budget/diversity/etc.),
  30-min TTL. **Why in-memory:** matches the app's scale and needs no extra infra; repeat clicks are
  instant. **Trade-off:** per-instance and non-persistent (acceptable, noted as a limitation).

---

## 10. Third-Party Integration Choices

| Need | Choice | Why |
|------|--------|-----|
| Event catalog | ~24 free feeds/sites via `EventSource` implementations | Real, current, multi-borough coverage without paid APIs |
| Storage | Supabase Postgres | Managed Postgres + RLS + easy service-role writes from cron |
| Curation | OpenAI `gpt-5-mini` via AI Gateway | Fast, cheap, reliable structured ranking; not used to search |
| Weather | Open-Meteo | Free, **no API key**, 7-day forecast |
| Address autocomplete | Photon (OpenStreetMap) | Free, **no API key**, real dropdown |
| Travel coordinates | US Census Geocoder | Free, **no API key**, good for US street addresses |
| Maps links | Google Maps URL scheme | No SDK/key — just a deep link |
| Calendar | Google Calendar OAuth | The one input the user asked to import live |

**Cross-cutting why:** wherever possible we chose **key-less, zero-billing** providers. The only
credentialed dependencies are Supabase, the AI Gateway (the curation step), and Google Calendar.

---

## 11. Auth / Secrets

- **Service-role Supabase key** is used only server-side (cron writes + route reads) and bypasses
  RLS; public clients can only *read* via RLS policies.
- **Google OAuth tokens** live in httpOnly cookies set by the server callback — never in client JS
  or localStorage.
- **Cron endpoint** is gated by `CRON_SECRET`.
- **Why:** keep every secret and every write server-side; the browser only reads public data.

---

## 12. Error Handling Strategy

- `/api/plan` classifies errors into typed codes — `billing` (missing payment method), `rate_limit`
  (free-tier throttling), `error` (everything else) — and the client shows an actionable toast
  (longer duration for billing/rate-limit). Empty results are a valid outcome, not an error.
- **AI failure is non-fatal:** the plan route falls back to a deterministic interest match.
- **Ingest failures are contained:** a per-source try/catch skips bad feeds; the run's outcome and
  error are recorded in `ingestion_logs`.
- **Why:** the user should always get *something* real from the catalog, and operators should be
  able to audit ingestion health.

---

## 13. Component Boundaries

- One concern per component: `profile-form`, `calendar-panel`, `weather-strip`, `special-requests`,
  `weekly-plan`, `worldcup-spots`, `address-autocomplete`.
- `page.tsx` is the single orchestrator/state owner; children are controlled via props + callbacks.
- **Why:** small, focused files with explicit top-down state and bottom-up events.

---

## 14. Known Architectural Limitations (accepted, not bugs)

- **Catalog freshness** is bounded by the daily cron and source coverage; new events appear only
  after the next ingest.
- **In-memory plan cache** is per-instance and non-persistent.
- **localStorage profile** is per-browser, no sync (the catalog itself is shared).
- **Travel times are straight-line estimates**, not routing-API accurate.
- **Free-tier AI rate limits** can throttle the curation step (mitigated by the deterministic
  fallback + caching + clear messaging).
- **`lib/event-links.ts` is legacy** dead code from the old live-search design (link
  normalization / wrong-city / reachability helpers). It is no longer imported and can be removed.

These are conscious trade-offs aligned with the catalog-backed, shared-data, fast-serving scope.
Upgrade paths (more sources, real transit routing, accounts, distributed cache, paid AI tier) are
noted in `PRD.md`.
