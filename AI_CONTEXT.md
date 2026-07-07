# AI_CONTEXT.md

> Persistent context for the **NYC Activities** app. Captures what's shared and decided so work
> can resume after a chat restart. Read this together with `PRD.md` (what it does) and
> `ARCHITECTURE.md` (why it's built this way) before making changes.

---

## 1. What the app is (current design)

A personal **NYC weekly activities planner** backed by a **daily-refreshed event catalog**.

- A **daily cron** (`/api/cron/ingest`, 08:00 UTC) ingests real upcoming NYC events from ~24
  sources into a **Supabase `events` table** (deduped, geocoded, categorized).
- On demand, `/api/plan` **reads** that catalog (pre-filtered to the user's interests), has
  `openai/gpt-5-mini` **curate** the best events **by id** (never inventing anything), then applies
  deterministic budget / working-hours / travel filters.
- Inputs: calendar (Google OAuth or manual), working hours, home/office addresses, interests,
  diversity, max travel, budget, approximate-location toggle, and ad-hoc requests. Profile is
  stored in `localStorage`; the catalog is shared in Supabase.
- **World Cup & Soccer** viewing is shown as location-first **spots** (per venue, with a date span),
  not date-grouped cards.

> **This replaced the original architecture** — a live per-request web search (Perplexity
> `sonar-pro` + `gpt-5-mini` structuring). The catalog-backed design is faster, cheaper, more
> reliable, and has no dead/hallucinated links (every link comes from a source feed).

---

## 2. Original request (verbatim intent)

Build a web app that takes: the user's calendar, usual working hours, home and office address,
general weather conditions, interests and diversity of activities, and ad-hoc requests ("need to
meet a friend this Thursday"). It should surface a list of **weekly activities** the user can attend.

---

## 3. Key decisions (current)

| Topic | Decision |
| --- | --- |
| Activity source | **Pre-ingested catalog** from ~24 real NYC feeds/sites (not live search) |
| Storage | **Supabase Postgres** (`events` + `ingestion_logs`), RLS public-read, service-role writes |
| Ingestion | **Daily Vercel Cron** at 08:00 UTC, 14-day horizon, `CRON_SECRET`-gated |
| Dedupe | **Deterministic UUID** (hash of source + source event id) + upsert on PK |
| AI role | **Curate only** — `openai/gpt-5-mini`, `Output.object()`, minimal reasoning; picks event ids + soft metadata, never invents events/links/dates |
| AI failure | **Deterministic interest-match fallback** so the DB always serves a plan |
| Hard limits | **Deterministic** budget / working-hours / travel filters in code |
| Travel | **Straight-line Haversine** estimate; coords via **US Census Geocoder** |
| Address autocomplete | **Photon/OpenStreetMap** via `/api/geocode` |
| Weather | **Open-Meteo** (free, no key) |
| World Cup & Soccer | **Location-first spots**, reclassified to a canonical category at ingest |
| Profile persistence | **Browser `localStorage`** (catalog is shared) |

---

## 4. Firm user preferences & rules (do not violate)

- **Only show events clearly happening** with a real, working link. Links come from the source
  feeds (stored in `events.event_url`) — never model-invented.
- **Strict interest matching** — pre-filtered in SQL and enforced again by the AI curator. Never pad
  with tangential suggestions. If nothing matches, return an empty plan with a friendly empty state.
- **Only the next 7 days from today** (NY time) — never past events. Ongoing multi-day events stay
  visible for their whole run. Order chronologically.
- **Enforce budget, working hours, and max travel deterministically** (not via the model).
- **Travel times** shown from both home and office on every card.
- **Location → Google Maps**, **event → source page**.
- **World Cup & Soccer** = location-first spots, not date cards.
- No emojis in UI or code unless explicitly requested.

---

## 5. Architecture quick reference

**Routes (`app/api/`)**
- `plan/route.ts` — serving path. Reads catalog (`fetchUpcomingEvents`, interest pre-filter),
  AI curation by id (`curatedSchema`/`pickSchema`), deterministic filters (budget/hours/travel/
  approx), NDJSON streaming, 30-min in-memory cache, error classification.
- `cron/ingest/route.ts` — daily ingestion: fetch all `eventSources`, dedupe, `reclassifyFootball`,
  `enrichCoordinates` (capped 80/run), upsert, delete finished, write `ingestion_logs`.
- `worldcup/route.ts` — standalone browse of World Cup viewing spots (delegates to `lib/worldcup.ts`).
- `weather/route.ts` — Open-Meteo 7-day NYC forecast.
- `geocode/route.ts` — Photon/OSM address autocomplete (NYC-biased).
- `google/auth`|`callback`|`events`|`disconnect` — Google Calendar OAuth + import.

**Components (`components/`)**
- `profile-form.tsx`, `calendar-panel.tsx`, `weather-strip.tsx`, `special-requests.tsx`,
  `weekly-plan.tsx`, `worldcup-spots.tsx`, `address-autocomplete.tsx`.

**Shared (`lib/`)**
- `types.ts` — `Profile`, `Activity`, `WeeklyPlan`, `WorldCupSpot(s)`, `WeatherDay`, enums,
  `INTEREST_OPTIONS` (incl. "World Cup & Soccer" and "Others"), `INTEREST_KEYWORDS`.
- `supabase/server.ts` — service-role client (server-only).
- `event-sources/` — `index.ts` (registry), `types.ts` (`EventSource`/`NormalizedEvent`),
  `util.ts` (ids, NY↔UTC, category inference, World Cup detection), `tribe.ts` (shared Tribe-plugin
  source factory), and one file per source (~24 total).
- `worldcup.ts` — aggregates World Cup viewing into per-venue spots.
- `geo.ts` — Haversine travel estimate + US Census geocoding (cached).
- `use-local-storage.ts`, `google.ts`.
- `event-links.ts` — **legacy** helpers from the old live-search design; no longer imported.

**Data (Supabase)**
- `events` — the catalog (see `PRD.md` §9 and `NormalizedEvent`). RLS public-read.
- `ingestion_logs` — one row per ingest run (status/counts/error). RLS public-read.

---

## 6. Environment variables

| Variable | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_URL` | Catalog access | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server reads + cron writes (bypasses RLS) | Yes |
| `AI_GATEWAY_API_KEY` | AI curation step | Yes (plan degrades to deterministic fallback without it) |
| `CRON_SECRET` | Secures `/api/cron/ingest` | Recommended (open if unset) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar connect | For Calendar |

Supabase also provisions `POSTGRES_*` / `NEXT_PUBLIC_SUPABASE_*`. Open-Meteo, Photon, and the
Census geocoder need no key.

---

## 7. Known limitations / open issues

- **Catalog freshness** bounded by the daily cron + source coverage; new events appear after the
  next ingest.
- **Free-tier AI rate limits** can throttle curation (mitigated by the deterministic fallback +
  caching + clear messaging).
- **In-memory plan cache** is per-instance, non-persistent.
- **Browser-only profile** (no cross-device sync); the catalog itself is shared.
- **Travel times are straight-line estimates**, not a routing API.
- **`lib/event-links.ts`** is dead legacy code and can be removed.

---

## 8. Design system

- Light mode, warm editorial NYC palette: off-white background, ink foreground, single **amber
  accent**. Fonts: Geist (sans) + Geist Mono (labels/headers). Tailwind v4 with tokens in
  `app/globals.css`. Flexbox-first. No purple, minimal gradients.

---

## 9. How to resume after a restart

1. Read this file, `PRD.md`, and `ARCHITECTURE.md`.
2. Confirm Supabase env vars are set (the catalog is the backbone) and `AI_GATEWAY_API_KEY` for
   curation. Check `ingestion_logs` if the catalog looks empty/stale.
3. Respect all rules in Section 4 — several were hard-won through iteration.
4. Most sensitive areas: the interest pre-filter + "Others"/"Festivals" special-casing and the
   deterministic filters in `app/api/plan/route.ts`, and the date-window / World Cup reclassification
   logic in `lib/event-sources/util.ts` and `cron/ingest/route.ts`. Re-read them before changing
   matching/filtering/ingest behavior.
5. To add an event source: implement `EventSource` in a new `lib/event-sources/<name>.ts` and
   register it in `index.ts` (reuse `createTribeSource` for "The Events Calendar" sites).
