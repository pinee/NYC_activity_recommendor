# NYC Activities — Product Requirements Document

## 1. Overview

**NYC Activities** is a personal weekly-activities concierge for New York City. It
takes a user's calendar, working hours, home/office locations, the live weather
forecast, their interests, and any ad-hoc requests, then searches the live web and
returns a curated, date-anchored list of real, bookable NYC activities for the next
7 days.

- **Platform:** Next.js 16 (App Router) web app
- **Audience:** NYC residents/workers who want a tailored weekly plan without manually
  scouring event listings
- **Core promise:** Every suggested activity is real, happening within the next 7 days,
  matches the user's stated interests, and links to a working NYC page where it can be
  viewed or booked.

## 2. Goals & Non-Goals

### Goals
- Generate a personalized, weather-aware weekly activity plan from live web data.
- Strictly match the user's selected interests — no tangential/filler suggestions.
- Only surface activities within the upcoming 7 days (never past events).
- Attach a real, reachable, NYC-specific link to every activity.
- Make the experience feel fast through staged progress streaming and caching.

### Non-Goals
- In-app ticket purchasing/checkout (we link out to the source instead).
- Multi-city support (NYC only by design).
- Long-term persistence of plans or account history (current build is browser-only
  for profile data; plans are generated on demand).

## 3. User Inputs

| Input | Description | Mechanism |
| --- | --- | --- |
| Calendar | Busy time blocks to avoid | Google Calendar OAuth import **or** manual busy-block entry |
| Working hours | Work start/end + working days | Manual entry; used to bias evenings on workdays, daytime on days off |
| Home address | Used for travel-time + weather | Address autocomplete (Photon/OpenStreetMap, NYC-biased, no API key) |
| Office address | Used for travel-time estimates | Address autocomplete (same as above) |
| Weather | Live 7-day NYC forecast | Open-Meteo API (free, no key); biases indoor vs outdoor picks |
| Interests | Activity categories to match | Multi-select from `INTEREST_OPTIONS` |
| Diversity | 1 = core interests → 5 = surprise me | Slider |
| Max travel time | Caps how far to suggest | Slider (minutes) |
| Budget | free / low / medium / any | Select |
| Special requests | Ad-hoc needs ("meet a friend Thursday") | Free-text request list |

Profile data is persisted in the browser via a `localStorage` hook (no database).

## 4. Core Flow

1. User fills in profile, addresses, interests, calendar, and any special requests.
2. App fetches the live NYC weather forecast (Open-Meteo).
3. User clicks **Build my week** → streams to `POST /api/plan`.
4. **Step 1 — Research:** `perplexity/sonar-pro` performs live web search across many
   authoritative NYC sources for real events on the allowed upcoming dates.
5. **Step 2 — Structuring:** `openai/gpt-5-mini` (minimal reasoning) converts research
   notes into strict JSON, anchoring each activity to an exact ISO date and assigning a
   real source link.
6. **Post-processing:** filter to the valid 7-day window, attach/repair links, reject
   wrong-city and dead links, sort chronologically.
7. Results render grouped by real date, with travel times, weather context, source
   links, and a "Sources searched" list.

## 5. Key Features & Business Rules

### 5.1 Interest matching (strict)
- Every returned activity MUST belong to one of the user's interest categories.
- No tangential suggestions (e.g. no restaurants when the search is running/fitness).
- If nothing matches, the plan is intentionally **empty** with a friendly empty state —
  never padded with off-topic filler.

### 5.2 Date anchoring (next 7 days only)
- "Today" is computed in `America/New_York` regardless of server timezone.
- Each activity carries an ISO `date` constrained to today + the next 6 days.
- The model is instructed to never use a past date; the server also filters out any
  activity whose date falls outside the valid window.
- Results are grouped and ordered chronologically from today (e.g. "Wednesday · Jun 24").

### 5.3 Link quality & reachability
- Each activity must have a real bookable link or it is dropped.
- Link selection priority:
  1. Model-provided URL (if real and not wrong-city)
  2. Best-matching citation by **distinctive** venue/title tokens (generic/temporal words
     like "city", "festival", "june" are ignored to avoid false matches)
  3. NYC events-listing/calendar page as a **last-resort fallback**
- **Always rejected:** wrong-city pages (e.g. `timeout.com/chicago/...`), search-engine
  URLs, invented/bare-domain URLs.
- **Reachability check:** every candidate link is fetched in parallel; links that 404/410,
  server-error, or fail (DNS/timeout) are dropped. Bot-block codes (401/403/405/429) are
  intentionally kept since those pages load fine in a browser.
- URLs without a protocol are normalized to `https://` to avoid relative-path 404s.

### 5.4 Travel times
- Each activity shows estimated one-way travel time **from home** and **from office**,
  including mode (subway/walk/bike), e.g. "~25 min by subway".
- Estimates are omitted gracefully if the relevant address is missing.

### 5.5 Maps & source links
- The venue/location on each card links to a Google Maps search built from venue +
  address + neighborhood + "New York, NY".
- The event title and a "Details" link open the original source in a new tab.

### 5.6 Weather awareness
- Live Open-Meteo 7-day forecast displayed as a strip.
- Rainy/cold days bias the plan toward indoor activities.

## 6. Performance & Latency

The dominant cost is the live web-search call. Optimizations applied:
- **Staged progress streaming** (NDJSON): "Searching live NYC listings…" →
  "Verifying event links are live and bookable…" → "Organizing your week…" so the wait
  feels short instead of a frozen spinner.
- **Result cap:** up to `MAX_ACTIVITIES = 15` to reduce generation time in both steps.
- **Minimal reasoning** on the `gpt-5-mini` structuring step (it's just reformatting).
- **30-minute in-memory cache** keyed by interests/addresses/week/requests — repeat
  requests with the same inputs return instantly.
- **Server-side parallelization** of link reachability checks.

> Note: `sonar-pro` is used for research accuracy (NYC-specific sources) at the cost of
> some latency. An earlier switch to faster `sonar` produced wrong-city/aggregator
> sources and was reverted.

## 7. Architecture

### Routes (App Router, `app/`)
| Path | Purpose |
| --- | --- |
| `app/page.tsx` | Main UI: inputs, weather, generate button, streamed plan |
| `app/api/plan/route.ts` | Two-step AI pipeline; streams NDJSON status + result |
| `app/api/weather/route.ts` | Open-Meteo NYC forecast proxy |
| `app/api/geocode/route.ts` | Photon/OpenStreetMap address autocomplete (NYC-biased) |
| `app/api/google/auth/route.ts` | Start Google Calendar OAuth |
| `app/api/google/callback/route.ts` | OAuth callback / token exchange |
| `app/api/google/events/route.ts` | Fetch imported calendar events |
| `app/api/google/disconnect/route.ts` | Clear Google session |

### Components (`components/`)
- `profile-form.tsx` — working hours, addresses (autocomplete), interests, sliders, budget
- `address-autocomplete.tsx` — debounced, keyboard-accessible address dropdown
- `calendar-panel.tsx` — Google connect + manual busy blocks
- `weather-strip.tsx` — live forecast strip
- `special-requests.tsx` — ad-hoc request list
- `weekly-plan.tsx` — date-grouped results, activity cards, sources

### Shared (`lib/`)
- `types.ts` — `Profile`, `Activity`, `WeeklyPlan`, `WeatherDay`, interest/day enums
- `use-local-storage.ts` — browser persistence hook
- `google.ts` — OAuth + Calendar helpers

## 8. Tech Stack

- **Framework:** Next.js 16 (App Router), React, TypeScript
- **Styling:** Tailwind v4 + shadcn/ui (light, editorial NYC theme; warm off-white,
  ink, single amber accent)
- **AI:** Vercel AI SDK 6 via AI Gateway
  - Research: `perplexity/sonar-pro` (built-in live web search)
  - Structuring: `openai/gpt-5-mini` with `Output.object()` (Zod schema)
- **External APIs:** Open-Meteo (weather), Photon/OpenStreetMap (geocoding), Google
  Calendar (OAuth)

## 9. Environment Variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | AI plan generation | Bills against the key's account; bypasses project-team billing gate |
| `GOOGLE_CLIENT_ID` | Google Calendar connect | From a Google Cloud OAuth app |
| `GOOGLE_CLIENT_SECRET` | Google Calendar connect | From a Google Cloud OAuth app |

> Weather and geocoding use free, key-less APIs.

## 10. Error Handling

The `/api/plan` stream emits typed messages (`status`, `error`, `result`). Known error
classes surface specific, actionable messages:
- **Billing:** "AI Gateway needs a payment method…" (credit-card/payment wording).
- **Rate limit (free tier):** "Your AI Gateway free-tier limit was hit. Wait a minute and
  try again, or add paid credits…" (longer-lasting toast).
- **Generic:** "Could not build your plan. Please try again."

Empty results are treated as a valid outcome (friendly empty state), not an error.

## 11. Known Limitations / Future Work

- **Free-tier rate limits** can interrupt back-to-back generations (~60s cooldown). Paid
  AI Gateway credits remove this.
- Travel times are AI estimates, not live transit-API routing.
- Profile data is browser-only; no cross-device sync or saved plan history.
- Link reachability check keeps bot-blocked pages (401/403/429) which are usually fine in
  a browser but are not deep-verified for exact-event accuracy.
- Potential future additions: real transit routing (Google/Mapbox), database-backed
  accounts and saved plans, in-app booking, push/email weekly digests.
