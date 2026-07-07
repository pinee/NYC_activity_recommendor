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
   `events` catalog (deduped, geocoded, categorized).
2. On demand, `/api/plan` **reads the catalog** (pre-filtered to the user's interests),
   has an AI model **curate** the best picks by event id (never inventing events, dates,
   or links), then applies deterministic budget/working-hours/travel filters.
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
| Interests | Activity categories to match | Multi-select from `INTEREST_OPTIONS` (incl. "World Cup & Soccer" and "Others") |
| Diversity | 1 = core interests → 5 = surprise me | Slider |
| Max travel time | Caps how far to suggest | Slider (minutes) — enforced deterministically via geocoded distance |
| Budget | free / low / medium / any | Select — enforced deterministically against parsed prices |
| Include approximate locations | Whether to keep events whose coordinates are only approximate | Toggle |
| Special requests | Ad-hoc needs ("meet a friend Thursday") | Free-text request list |

Profile/calendar/request inputs are persisted in the browser via a `localStorage` hook.
The **event catalog itself lives in Supabase** and is shared across all users.

## 4. Core Flow

1. User fills in profile, addresses, interests, calendar, and any special requests.
2. App fetches the live NYC weather forecast (Open-Meteo).
3. User clicks **Generate my weekly activities** → streams from `POST /api/plan`.
4. **Read catalog:** the route queries the Supabase `events` table for events whose span
   overlaps the next 7 days, **pre-filtered** to the user's interest keywords (with special
   handling for "Festivals & fireworks" by title, and "Others" as a catch-all).
5. **AI curation:** `openai/gpt-5-mini` (minimal reasoning) selects the best events **by
   id** and adds soft metadata (neighborhood, why-it-fits, travel note). It can never
   invent events, dates, or links. If the model is unavailable, a deterministic
   interest-match fallback serves the catalog directly.
6. **Deterministic filters:** budget cap, working-hours conflicts, and straight-line
   travel-time limit are applied after curation; approximate-location events are dropped if
   the user opted out.
7. Results render grouped by real date, with travel times, weather context, source links,
   a "Sources" list, and a note about what was filtered out.
8. If the user selected **World Cup & Soccer**, those events are shown as aggregated viewing
   **spots** (location-first) instead of date-grouped cards.

## 5. Key Features & Business Rules (what we optimized for)

### 5.1 Interest matching (strict, two layers)
- The **DB query pre-filters** to events whose `category` matches the user's interest
  keywords (`INTEREST_KEYWORDS`), so the candidate set is always relevant, not just "the
  earliest N events".
- The **AI curator** is then instructed to pick only events that directly belong to a
  stated interest and to drop anything tangential.
- **"Festivals & fireworks"** also matches on the event **title** (holiday events are
  usually categorized by activity type, e.g. "Concerts", not by the holiday name).
- **"Others"** is a catch-all that matches events matching *no* other interest (expressed as
  a negation over the full keyword universe).
- If nothing matches, the plan is intentionally **empty** with a friendly empty state.

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

### 5.4 Travel-time filtering (deterministic)
- Home/office addresses are geocoded (US Census Geocoder, free, cached).
- Each event's distance is a straight-line (Haversine) estimate inflated by a detour factor
  and a blended city speed → an approximate one-way minutes value.
- An event is dropped only when we have both an origin and an event location **and** the
  closer of home/office exceeds the user's max-travel preference.
- Displayed as "~25 min" from home and office on each card.

### 5.5 Budget & working-hours filtering (deterministic)
- **Budget:** the cheapest dollar figure is parsed from the free-text price; events are
  dropped only when a parsed price exceeds the cap (free = $0, low ≤ $25, medium ≤ $75, any
  = no cap). Unknown/free prices always pass.
- **Working hours:** events that start during the user's working hours on a working day are
  dropped.
- A **"filtered" note** tells the user how many events were hidden and why (too far / over
  budget / during working hours / approximate location).

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
- Available both inline (when the interest is selected) and via a standalone **Browse all
  World Cup viewing** button (`/api/worldcup`).

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
- **Interest pre-filter in SQL:** the candidate set is relevant and capped (500 rows) before
  the AI sees it.
- **Single, minimal-reasoning AI call:** the model only *curates* (picks ids + light
  metadata), so latency and cost are low, and it degrades gracefully to a deterministic
  filter if unavailable.
- **Staged progress streaming** (NDJSON): "Reading the latest NYC events…" → "Organizing
  your week…".
- **30-minute in-memory cache** keyed by interests/addresses/week/requests — repeat requests
  with the same inputs return instantly.
- **Result cap:** up to `MAX_ACTIVITIES = 15`.

## 8. Architecture

### Routes (App Router, `app/`)
| Path | Purpose |
| --- | --- |
| `app/page.tsx` | Main UI: inputs, weather, generate + World Cup buttons, streamed plan |
| `app/api/plan/route.ts` | Reads catalog, AI-curates by id, deterministic filters, NDJSON stream |
| `app/api/cron/ingest/route.ts` | Daily ingestion from all sources into Supabase (cron) |
| `app/api/worldcup/route.ts` | Standalone browse of all World Cup viewing spots |
| `app/api/weather/route.ts` | Open-Meteo NYC forecast proxy |
| `app/api/geocode/route.ts` | Photon/OpenStreetMap address autocomplete (NYC-biased) |
| `app/api/google/auth`/`callback`/`events`/`disconnect` | Google Calendar OAuth + import |

### Components (`components/`)
- `profile-form.tsx` — working hours, addresses (autocomplete), interests, sliders, budget,
  approximate-location toggle
- `address-autocomplete.tsx` — debounced, keyboard-accessible address dropdown
- `calendar-panel.tsx` — Google connect + manual busy blocks
- `weather-strip.tsx` — live forecast strip
- `special-requests.tsx` — ad-hoc request list
- `weekly-plan.tsx` — date-grouped results, activity cards, sources, filtered note
- `worldcup-spots.tsx` — location-first World Cup viewing spots

### Shared (`lib/`)
- `types.ts` — `Profile`, `Activity`, `WeeklyPlan`, `WeatherDay`, `WorldCupSpot(s)`,
  interest/day enums, `INTEREST_KEYWORDS`
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
| `status`, `last_updated`, `created_at`, `raw_json` | Housekeeping/audit |

## 10. Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **Database:** Supabase Postgres (`@supabase/supabase-js`, service-role on the server)
- **Styling:** Tailwind v4 + shadcn/ui (light, editorial NYC theme; warm off-white, ink,
  single amber accent)
- **AI:** Vercel AI SDK 6 via AI Gateway — `openai/gpt-5-mini` with `Output.object()` (Zod
  schema), minimal reasoning; used only to *curate* catalog events, not to search or invent
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
