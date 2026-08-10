# NYC Activities — Product Requirements Document

## 1. Overview

**NYC Activities** is a personal weekly-activities concierge for New York City. It
combines a **daily-refreshed catalog of real NYC events** (collected from ~24
authoritative sources) with the user's calendar, working hours, home/office locations,
the live weather forecast, their interests, and any ad-hoc requests, then returns a
curated, date-anchored list of real, bookable activities for the next 7 days.

- **Platform:** Next.js 16 (App Router) web app
- **Audience:** NYC residents/workers who want a tailored weekly plan without manually
  scouring event listings
- **Core promise:** Every suggested activity is a real event drawn from an authoritative
  source, is happening within the next 7 days, matches the user's stated interests, and
  links to the source's own working page where it can be viewed or booked.

### How it works at a glance
1. A **daily cron job** ingests upcoming events from ~24 NYC feeds/sites into a Supabase
   `events` catalog (deduped, geocoded, categorized, and **vector-embedded** for semantic
   search).
2. On demand, `/api/plan` **reads the catalog** with the hard constraints (budget /
   working-hours / travel / approximate-location) already applied **in SQL**, via an
   interest-keyword filter and/or **semantic search** over the user's free-text description
   and profile signals, then has an AI model **curate** the best picks by event id (never
   inventing events, dates, or links).
3. Results render grouped by real date with travel times, weather context, and source
   links. World Cup & soccer viewing is shown as location-first "spots".

> **Note:** This is a significant change from the original design, which performed a live
> web search (Perplexity + a structuring model) on every request. The app now reads from
> a pre-ingested database, which makes plans faster, cheaper, more reliable, and free of
> dead/hallucinated links (every link comes straight from the source feed).

## 2. Goals & Non-Goals

### Goals
- Generate a personalized, weather-aware weekly activity plan from a fresh catalog of real
  NYC events.
- Strictly match the user's selected interests — no tangential/filler suggestions.
- Only surface activities within the upcoming 7 days (never past events).
- Every activity links to the source's real event page (links come from the feeds, not
  the model).
- Enforce hard constraints deterministically: budget, working hours, and max travel time.
- Make the experience feel instant (DB read + cache) rather than waiting on a live search.

### Non-Goals
- In-app ticket purchasing/checkout (we link out to the source instead).
- Multi-city support (NYC only by design).
- User accounts / cross-device sync (profile is browser-only; the event catalog is shared).

## 3. User Inputs

| Input | Description | Mechanism |
| --- | --- | --- |
| Calendar | Busy time blocks to avoid | Google Calendar OAuth import **or** manual busy-block entry |
| Working hours | Work start/end + working days | Manual entry; biases evenings on workdays, daytime on days off |
| Home address | Used for travel-time filtering | Address autocomplete (Photon/OpenStreetMap, NYC-biased, no API key) |
| Office address | Used for travel-time filtering | Address autocomplete (same as above) |
| Weather | Live 7-day NYC forecast | Open-Meteo API (free, no key); biases indoor vs outdoor picks |
| Interests | Activity categories to match | Multi-select from `INTEREST_OPTIONS` (incl. "World Cup & Soccer" and "Others"); optional — semantic search can drive a plan without them |
| Choosing for | Who the activity is for: solo / couple / family / colleagues / friends | Select — **optional**; feeds the embedding and the AI prompt (e.g. family always surfaces kid-friendly events) |
| Age group | Coarse bucket (under-18 … 65+) instead of an exact age | Select — **optional**; feeds the embedding and the AI prompt |
| Alcohol | alcohol-free / drinks please / no preference (mixed) | Select — **optional**; feeds the embedding and the AI prompt |
| Diversity | 1 = core interests → 5 = surprise me | Slider |
| Max travel time | Caps how far to suggest | Slider (minutes) — enforced deterministically in SQL via geocoded distance |
| Budget | free / low / medium / any | Select — enforced deterministically in SQL against parsed prices |
| Include approximate locations | Whether to keep events whose coordinates are only approximate | Toggle |
| Special requests | Ad-hoc needs / free-text mood ("meet a friend Thursday", "something chill and artsy") | Free-text list — also **embedded as the semantic-search query** |

Profile/calendar/request inputs are persisted in the browser via a `localStorage` hook.
The **event catalog itself lives in Supabase** and is shared across all users.

## 4. Core Flow

1. User fills in profile, addresses, interests (optional), the optional "About you" fields
   (choosing for / age group / alcohol), calendar, and any special requests.
2. App fetches the live NYC weather forecast (Open-Meteo).
3. User clicks **Generate my weekly activities** → streams from `POST /api/plan`.
4. **Resolve filters + read catalog (filter-first, in SQL):** the route geocodes home/office
   once, derives the hard constraints (budget cap, max travel, working hours/days,
   approximate-location) and passes them into the retrieval so **only attendable events
   whose span overlaps the next 7 days come back**. Retrieval combines an **interest-keyword
   filter** (with "Festivals & fireworks" also matching by title and "Others" as a catch-all)
   and/or **semantic vector search** over the user's free-text description plus the age /
   alcohol / choosing-for profile signals.
5. **AI curation:** `openai/gpt-5-mini` (minimal reasoning) selects the best events **by
   id** from the already-filtered pool and adds soft metadata (neighborhood, why-it-fits,
   travel note). It can never invent events, dates, or links, and treats the free-text
   description and profile signals as primary intent. If the model is unavailable, the
   already-filtered results are served directly (semantic-relevance / interest order).
6. **Merge & display:** DB fields are authoritative (title/date/url/price/image); model
   metadata fills why/travel/neighborhood. Straight-line travel-time labels from home and
   office are computed here for display only (the travel *filter* already ran in SQL).
7. Results render grouped by real date, with travel times, weather context, source links,
   and a de-duplicated "Sources" list. (There is no post-hoc "filtered out" note — the hard
   constraints are applied up front, so nothing needs to be reported after the fact.)
8. If the user selected **World Cup & Soccer**, those events are shown inline as aggregated
   viewing **spots** (location-first) instead of date-grouped cards.

## 5. Key Features & Business Rules (what we optimized for)

### 5.1 Relevance matching (interest keywords + semantic search)
- The **SQL retrieval pre-filters** to events whose `category` matches the user's interest
  keywords (`INTEREST_KEYWORDS`), so the candidate set is always relevant, not just "the
  earliest N events".
- In addition (or instead, when no interests are selected), the user's free-text description
  drives **semantic vector search** over the embedded catalog, so someone can get a relevant
  plan purely by describing a mood ("something chill and artsy after work").
- The **AI curator** is then instructed to pick only events that directly fit the user's
  intent and to drop anything tangential.
- **"Festivals & fireworks"** also matches on the event **title** (holiday events are
  usually categorized by activity type, e.g. "Concerts", not by the holiday name).
- **"Others"** is a catch-all that matches events matching *no* other interest (expressed as
  a negation over the full keyword universe).
- If nothing matches, the plan is intentionally **empty** with a friendly empty state.

### 5.1a Personalization signals (choosing for / age group / alcohol)
- All three are **optional**. When set, they are rendered as natural-language signals that
  are folded into **both** the semantic-search query (so retrieval is biased the same way)
  **and** the AI curation prompt — never used as hard filters.
- **Choosing for:** couple → date-friendly; colleagues → group-friendly, low-key; friends →
  lively/social; **family → always include kid-friendly / all-ages events even when the
  adult's age group is older.**
- **Age group** and **alcohol** (alcohol-free steers away from bars/breweries; "drinks
  please" welcomes them) further nudge selection.
- A default profile (all three unset) produces no signal, so plain interest-based plans are
  unaffected.

### 5.2 Date anchoring (next 7 days only)
- "Today" is computed in `America/New_York` regardless of server timezone.
- The query keeps events whose span overlaps `[start of today, +7 days]`, including
  **ongoing multi-day** events that began earlier.
- Single-day events that already started earlier today are dropped in JS (a search at 8 PM
  only shows things starting later); multi-day events remain visible for their whole run.
- Ongoing events are anchored to "today" for display; results are grouped/ordered
  chronologically (e.g. "Wednesday · Jun 24"), with a "Runs through …" label for multi-day.

### 5.3 Link quality (guaranteed real by construction)
- Every event's `event_url` comes **directly from its source feed/site** during ingest, so
  links are real source pages by construction — there is no model-invented URL to verify.
- Sources normalize `http://` → `https://` where relevant.
- The plan surfaces a de-duplicated **Sources** list (by hostname) from the events shown.

### 5.4 Travel-time filtering (deterministic, in SQL)
- Home/office addresses are geocoded **once up front** (US Census Geocoder, free, cached)
  and the coordinates are passed into the SQL retrieval.
- The `event_travel_min()` SQL function mirrors `lib/geo.ts`: a straight-line (Haversine)
  estimate inflated by a detour factor and a blended city speed → an approximate one-way
  minutes value.
- An event is dropped **during retrieval** only when both an origin and an event location
  exist **and** the closer of home/office exceeds the user's max-travel preference.
- The same estimate is displayed as "~25 min" from home and office on each card (display
  only — the filter already ran in SQL).

### 5.5 Budget & working-hours filtering (deterministic, in SQL)
- **Budget:** a derived `price_usd` column (populated by a DB trigger from the free-text
  price) is compared against the cap in SQL (free = $0, low ≤ $25, medium ≤ $75, any = no
  cap). Unknown/free prices always pass.
- **Working hours:** events that start during the user's working hours on a working day are
  dropped in SQL.
- Because all hard constraints run **before** retrieval and curation, only attendable events
  are ever fetched or ranked — there is **no post-hoc "filtered out" note** (it was removed
  along with the JS price parser).

### 5.6 Approximate-location handling
- Events whose coordinates are only approximate (geocoded from a neighborhood/venue name
  rather than an exact address) are flagged `approximate_location`.
- The user can opt out of these via a toggle, in which case they're dropped (their travel
  times can't be trusted).

### 5.7 World Cup & Soccer (location-first)
- Soccer/World Cup **viewing** events (watch parties, fan zones, big-screen screenings) are
  re-stamped at ingest with one canonical category so they collect under a single interest.
- They're presented as aggregated viewing **spots** (one entry per venue, with a date span
  and session count) rather than date-grouped cards, because fans already know match times.
- Surfaced **inline** within a generated plan when the "World Cup & Soccer" interest is
  selected. The standalone "Browse all World Cup viewing" button was **removed** from the UI
  once the tournament ended; the `/api/worldcup` endpoint still exists but is no longer
  linked from the app.

### 5.8 Maps & source links
- Each card's title/details link opens the source event page in a new tab.
- Venue/location links to a Google Maps search built from venue + address + neighborhood.

### 5.9 Weather awareness
- Live Open-Meteo 7-day forecast displayed as a strip; the AI biases outdoor picks toward
  outdoor-friendly days.

## 6. Data Ingestion (the daily catalog)

- **Schedule:** a Vercel Cron hits `/api/cron/ingest` daily at **08:00 UTC** (`vercel.json`).
- **Sources:** ~24 registered `EventSource` implementations in `lib/event-sources/`
  (NYC Parks RSS, SummerStage, Prospect Park, Green-Wood, Bryant Park, Central Park,
  Brooklyn Bridge Park, Hudson River Park, Hudson Yards, Governors Island, NYPL, Poster
  House, Rooftop Films/Cinema Club, TheSkint, Thought Gallery, Pulsd, City Happening/NYC
  Marquee, NYC For Free, Flatiron/NoMad, Downtown NY, Union Square, plus World Cup sources).
  Sites built on the "The Events Calendar" (Tribe) WordPress plugin share a
  `createTribeSource` helper.
- **Horizon:** each run ingests **14 days** ahead (a buffer beyond the 7-day view so the
  rolling window stays full between runs).
- **Pipeline per run:** fetch all enabled sources (a failing source is logged and skipped) →
  de-dup by deterministic id → re-classify World Cup viewing → enrich missing coordinates via
  geocoding (capped at 80/run) → **upsert** on primary key → **delete** events that have
  truly finished → write an `ingestion_logs` audit row.
- **Auth:** protected by a `CRON_SECRET` bearer token (Vercel Cron sends it automatically;
  if unset, the endpoint is open for local/dev use).

## 7. Performance & Latency

- **Catalog reads instead of live search:** the biggest win over the original design —
  plans no longer wait on a multi-second live web search; they read a pre-built DB.
- **Filter-first retrieval in SQL:** the hard constraints and the interest/semantic match run
  inside the `match_events` / `filter_events` RPCs, so only attendable, relevant rows come
  back (capped) before the AI sees them.
- **Precomputed embeddings:** event vectors are computed at ingest, so at request time only
  the user's short query is embedded — semantic search adds no meaningful latency.
- **Single, minimal-reasoning AI call:** the model only *curates* (picks ids + light
  metadata), so latency and cost are low, and it degrades gracefully to a deterministic
  filter if unavailable.
- **Staged progress streaming** (NDJSON): "Reading the latest NYC events…" → "Organizing
  your week…".
- **30-minute in-memory cache** keyed by all plan-affecting inputs (interests, addresses,
  week, requests, budget, working hours/days, travel/approx settings, and the choosing-for /
  age-group / alcohol signals) — repeat requests with the same inputs return instantly.
- **Result cap:** up to `MAX_ACTIVITIES = 15`.

## 8. Architecture

### Routes (App Router, `app/`)
| Path | Purpose |
| --- | --- |
| `app/page.tsx` | Main UI: inputs, weather, the **Generate my weekly activities** button, streamed plan (World Cup spots render inline in the plan) |
| `app/api/plan/route.ts` | Reads catalog, AI-curates by id, deterministic filters, NDJSON stream |
| `app/api/cron/ingest/route.ts` | Daily ingestion from all sources into Supabase (cron) |
| `app/api/worldcup/route.ts` | Standalone browse of all World Cup viewing spots (endpoint retained but no longer linked from the UI) |
| `app/api/admin/embeddings/route.ts` | Resumable backfill of missing event embeddings |
| `app/api/weather/route.ts` | Open-Meteo NYC forecast proxy |
| `app/api/geocode/route.ts` | Photon/OpenStreetMap address autocomplete (NYC-biased) |
| `app/api/google/auth`/`callback`/`events`/`disconnect` | Google Calendar OAuth + import |

### Components (`components/`)
- `profile-form.tsx` — working hours, addresses (autocomplete), interests, the optional
  "About you" selects (choosing for / age group / alcohol), sliders, budget,
  approximate-location toggle
- `address-autocomplete.tsx` — debounced, keyboard-accessible address dropdown
- `calendar-panel.tsx` — Google connect + manual busy blocks
- `weather-strip.tsx` — live forecast strip
- `special-requests.tsx` — ad-hoc request list
- `weekly-plan.tsx` — date-grouped results, activity cards, sources list, inline World Cup spots
- `worldcup-spots.tsx` — location-first World Cup viewing spots

### Shared (`lib/`)
- `types.ts` — `Profile` (incl. optional `company`/`ageGroup`/`alcohol`), `Activity`,
  `WeeklyPlan`, `WeatherDay`, `WorldCupSpot(s)`, interest/day enums, `INTEREST_KEYWORDS`,
  and the `COMPANY_OPTIONS` / `AGE_GROUP_OPTIONS` / `ALCOHOL_OPTIONS` option lists
- `embeddings.ts` — event/query embeddings (`text-embedding-3-small`) + `embedMissingEvents`
- `supabase/server.ts` — service-role Supabase client (server-only)
- `event-sources/` — source registry + one file per source + shared `util.ts`/`tribe.ts`
- `worldcup.ts` — aggregates World Cup viewing into spots
- `geo.ts` — Haversine travel estimate + US Census geocoding (cached)
- `use-local-storage.ts` — browser persistence hook
- `google.ts` — OAuth + Calendar helpers
- `event-links.ts` — **legacy** link-quality helpers from the old live-search design; no
  longer imported by the app (safe to remove).

### Data (Supabase Postgres)
- `events` — the activity catalog (see §9 for columns). RLS: public read; writes via the
  service role in the cron job.
- `ingestion_logs` — one row per ingest run (status, counts, errors). RLS: public read.

## 9. Data Model (`public.events`)

Key columns (mirrors `NormalizedEvent` in `lib/event-sources/types.ts`):

| Column | Notes |
| --- | --- |
| `id` (uuid, PK) | Deterministic id derived from source + source event id → upserts dedupe |
| `title`, `description` | Event text |
| `source`, `source_event_id`, `event_url` | Provenance + the real bookable link |
| `venue_name`, `address`, `borough`, `neighborhood` | Location text |
| `latitude`, `longitude` | Coordinates (from feed or geocoded); may be approximate |
| `approximate_location` (bool) | True when coordinates are not the exact venue |
| `category`, `tags[]`, `organizer` | Categorization (World Cup viewing gets a canonical category) |
| `start_time`, `end_time` (timestamptz) | UTC; NYC-local derived at read time |
| `price`, `currency` | Free-text price; parsed for the budget filter |
| `image_url` | Optional event image |
| `price_usd` (numeric, derived) | Set by a DB trigger from `price`; powers the SQL budget filter |
| `embedding` (vector(1536)) | pgvector semantic embedding (HNSW cosine index); powers semantic search |
| `series_key` (text, derived) | Groups recurring/multi-day occurrences into one logical event |
| `status`, `last_updated`, `created_at`, `raw_json` | Housekeeping/audit |

## 10. Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **Database:** Supabase Postgres + **pgvector** (`@supabase/supabase-js`, service-role on
  the server); retrieval + filtering encapsulated in SQL RPCs (`match_events`,
  `filter_events`)
- **Styling:** Tailwind v4 + shadcn/ui (light, editorial NYC theme; warm off-white, ink,
  single amber accent)
- **AI:** Vercel AI SDK 6 via AI Gateway — `openai/gpt-5-mini` with `Output.object()` (Zod
  schema), minimal reasoning; used only to *curate* catalog events, not to search or invent
- **Embeddings:** `openai/text-embedding-3-small` (1536 dims) via the AI Gateway — event and
  query vectors for semantic search (must match the `vector(1536)` column)
- **External APIs:** Open-Meteo (weather), Photon/OpenStreetMap (address autocomplete),
  US Census Geocoder (coordinates for travel), Google Calendar (OAuth), plus the ~24 event
  source feeds/sites
- **Scheduling:** Vercel Cron (`vercel.json`)

## 11. Environment Variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Catalog read/write | From the Supabase integration |
| `SUPABASE_SERVICE_ROLE_KEY` | Server writes (ingest) + reads | Service role bypasses RLS; server-only |
| `AI_GATEWAY_API_KEY` | AI curation step | Plan degrades to deterministic fallback if unavailable |
| `CRON_SECRET` | Securing the ingest endpoint | Vercel Cron sends it automatically; open if unset |
| `GOOGLE_CLIENT_ID` | Google Calendar connect | From a Google Cloud OAuth app |
| `GOOGLE_CLIENT_SECRET` | Google Calendar connect | From a Google Cloud OAuth app |

> The Supabase integration also provisions `POSTGRES_*`, `NEXT_PUBLIC_SUPABASE_*`, and
> related vars. Weather, address autocomplete, and Census geocoding need no key.

## 12. Error Handling

- The `/api/plan` stream emits typed messages (`status`, `error`, `result`). Known error
  classes surface specific, actionable messages: **billing** (missing payment method) and
  **rate limit** (free-tier throttling); everything else is a generic retry message.
- If AI curation fails, the route **falls back** to a deterministic interest match so the DB
  can still serve a plan (rather than erroring).
- Empty results are a valid outcome (friendly empty state), not an error.
- The ingest route records failures per-source and per-run in `ingestion_logs`.

## 13. Known Limitations / Future Work

- **Catalog freshness** is bounded by the daily cron and the coverage of the ~24 sources;
  brand-new events appear only after the next ingest.
- **Travel times are straight-line estimates**, not live transit-API routing.
- **Profile persistence is browser-only** (no accounts/sync); the event catalog is shared.
- **In-memory plan cache** is per-server-instance and non-persistent.
- **Legacy `lib/event-links.ts`** remains from the old design and can be deleted.
- Potential future additions: more sources / official APIs (Luma, Meetup, Ticketmaster),
  real transit routing, accounts and saved plans, in-app booking, push/email weekly digests.
