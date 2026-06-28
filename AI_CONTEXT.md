# AI_CONTEXT.md

> Persistent context for the **NYC Activities** app. This file captures everything shared and decided across the conversation so work can resume seamlessly after a chat restart. Read this together with `PRD.md` before making changes.

---

## 1. What the app is

A personal **NYC weekly activities planner**. The user provides their calendar, working hours, home/office addresses, interests, diversity preference, and ad-hoc requests. The app scrapes the live web via AI and returns a curated, date-anchored list of real NYC activities to attend over the next 7 days, each with a bookable link, travel times, and a Google Maps location link.

---

## 2. Original request (verbatim intent)

Build a web app that takes these inputs:
- The user's calendar
- Usual working hours
- Home and office address
- General weather conditions
- Interests and diversity of activities
- Ad-hoc requests like "need to meet a friend this Thursday"

It should **scrape the internet** and return a list of **weekly activities** the user can attend.

---

## 3. Decisions made (from clarifying questions)

| Topic | Decision |
| --- | --- |
| Activity source | **AI + live web search** (real internet results) |
| Persistence | **Browser-only** (localStorage) — no database |
| Calendar input | **Google Calendar connect** (OAuth) + manual busy-block fallback |
| Weather | **Live weather API** (Open-Meteo, free, no key) |
| Search model (final) | **`perplexity/sonar-pro`** — switched back from `sonar` for accurate NYC-specific sources |
| Structuring model | **`openai/gpt-5-mini`** with `Output.object()` + minimal reasoning |

---

## 4. Chronological history of user requests & how each was handled

1. **Initial build** — Created profile inputs, live weather, Google Calendar OAuth, and the AI recommendation engine with results UI.
2. **"Could not build your plan" error** — Root cause: AI Gateway requires billing. Added specific error messaging (billing detection).
3. **"I already have a credit card"** — Clarified the charge is tied to the **team that owns the project**, not the personal account. Explained where to add the card (team AI Gateway settings).
4. **Travel time request** — Added `travelFromHome` and `travelFromOffice` (estimated one-way time + mode) to each activity, shown on the card with Home/Office icons.
5. **Confused about billing location** — Gave step-by-step instructions for both adding a card to the project's team AND using an `AI_GATEWAY_API_KEY`.
6. **Make location clickable → Google Maps; make event clickable → original source** — Title links to source URL; location row links to a Google Maps search built from venue + address + neighborhood + NYC.
7. **Resolved billing via Option 2** — User added `AI_GATEWAY_API_KEY`. Confirmed working end-to-end.
8. **Bad link bug (`/barrys.com` 404)** — AI returned protocol-less URLs treated as relative paths. Added `normalizeSourceUrl` helper that prepends `https://` and rejects non-domains.
9. **Restaurant results when searching fitness** — Tightened both prompts to STRICT interest matching; allowed empty results; added a "no matches" empty state instead of erroring.
10. **Source coverage question ("only see City Happening")** — Added an explicit roster of authoritative NYC sources, required all-five-borough/neighborhood coverage, and surfaced cited sources as clickable chips ("Sources searched").
11. **Address dropdown / Google Maps sync request** — Added `AddressAutocomplete` component backed by `/api/geocode` (Photon/OpenStreetMap, free, no key, NYC-biased) with keyboard + mouse selection.
12. **Latency analysis & optimization** — Identified Perplexity research as ~60-80% of time. Applied: NDJSON staged-progress streaming, switched to faster `sonar` (later reverted), capped results, minimal reasoning, 30-min in-memory cache, parallelized weather + research.
13. **Links going to Google search** — Removed the Google-search fallback; fed citation **titles** (not just URLs) into structuring; added `bestCitationFor` code-side matcher.
14. **"Could not generate" again** — Root cause: **free-tier rate limit** (not a bug). Added rate-limit detection + accurate user message.
15. **Past events shown (Mon-Fri regardless of today)** — Anchored activities to real ISO dates (today + next 6 days, NYC time); filtered out past/out-of-window dates server-side; UI groups by real date chronologically.
16. **Missing links again + dead/404 links** — Added `isUrlReachable` live link verification (parallel HEAD/GET, drops 404/410/5xx/DNS failures, keeps bot-block 401/403/405/429). Require a working link or drop the event.
17. **Wrong-city link bug (NYC beer fest → Chicago events page)** — Split guards: `isWrongCityUrl` (always reject) vs `isGenericListingUrl` (allow only as NYC fallback). Tightened `bestCitationFor` to use only DISTINCTIVE tokens (excludes generic/temporal/location words).
18. **Model tradeoff decision** — User chose to switch research back to **`sonar-pro`** for accuracy over speed.
19. **PRD.md created** — Full product/technical documentation.
20. **AI_CONTEXT.md created** — This file.

---

## 5. Firm user preferences & rules (do not violate)

- **Only show events that are clearly happening** and have an **easily bookable, working link**. Better to omit an event than show a bad/dead/wrong link.
- **Never link to**: search-engine result pages, wrong-city pages, dead/404 links, or bare domains without `https://`.
- **Strict interest matching** — never pad with tangential suggestions (no restaurants for a fitness search). If nothing matches, return blank.
- **Only the next 7 days from today** — never past events. Order chronologically from today.
- **Travel times** from both home and office on every card.
- **Location → Google Maps**, **event → original/bookable source**.
- **Exhaustive, multi-borough, multi-source coverage** — don't over-rely on one publication.
- No emojis in UI or code unless explicitly requested.

---

## 6. Architecture quick reference

**Routes (`app/api/`)**
- `plan/route.ts` — core engine. NDJSON streaming, two AI steps, date anchoring, link resolution/verification, caching, error classification. Key helpers: `normalizeSourceUrl`, `tokenize`, `isWrongCityUrl`, `isGenericListingUrl`, `bestCitationFor`, `isUrlReachable`, `upcomingDates`, `buildPlan`.
- `weather/route.ts` — Open-Meteo 7-day NYC forecast.
- `geocode/route.ts` — Photon/OpenStreetMap address autocomplete (NYC-biased).
- `google/auth`, `google/callback`, `google/events`, `google/disconnect` — Google Calendar OAuth + event import.

**Components (`components/`)**
- `profile-form.tsx` — working hours, addresses (via `address-autocomplete.tsx`), interests, diversity & travel sliders, budget.
- `calendar-panel.tsx` — Google connect + manual busy blocks.
- `weather-strip.tsx` — forecast display.
- `special-requests.tsx` — ad-hoc requests ("meet a friend Thursday").
- `weekly-plan.tsx` — results: chronological date groups, activity cards (links, travel, maps), "Sources searched" chips, empty state.
- `address-autocomplete.tsx` — debounced geocode dropdown, keyboard accessible.

**Shared (`lib/`)**
- `types.ts` — `Profile`, `Activity` (incl. `date`, `travelFromHome/Office`, `url`), `WeeklyPlan`, `PlanSource`, `WEEK_DAYS`, etc.
- `use-local-storage.ts` — browser persistence hook.
- `google.ts` — OAuth + Calendar API helpers.

---

## 7. Environment variables

| Variable | Purpose | Required |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | AI Gateway access (research + structuring). Currently set — this is how billing was resolved. | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client | For Calendar connect |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret | For Calendar connect |

No key needed for Open-Meteo (weather) or Photon (geocoding).

---

## 8. Known limitations / open issues

- **Free-tier rate limits**: the current `AI_GATEWAY_API_KEY` is on the free tier; back-to-back generations get rate-limited. Wait ~60s between attempts, or add paid credits in Vercel AI Gateway. App detects this and shows an accurate message.
- **Latency**: `sonar-pro` + link verification can take 30-60s on a cold (uncached) run. Mitigated by staged progress UI and 30-min cache.
- **Browser-only persistence**: inputs are not synced across devices (per the user's choice).
- **Travel times are AI estimates**, not a routing API.

---

## 9. Design system

- Light mode, warm editorial NYC palette: off-white background, ink foreground, single **amber accent** (`--accent` ~ oklch(0.69 0.17 48)).
- Fonts: Geist (sans) + Geist Mono (labels/headers).
- Tailwind v4 with tokens in `app/globals.css`. Flexbox-first layouts. No purple, minimal gradients.

---

## 10. How to resume after a restart

1. Read this file and `PRD.md`.
2. Confirm `AI_GATEWAY_API_KEY` is still set (plan generation depends on it).
3. Respect all rules in Section 5 — these were hard-won through iteration.
4. The link-quality and date-window logic in `app/api/plan/route.ts` is the most sensitive area; re-read it before changing matching/filtering behavior.
