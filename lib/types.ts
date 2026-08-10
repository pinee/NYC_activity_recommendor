export const WEEK_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const

export type WeekDay = (typeof WEEK_DAYS)[number]

export const INTEREST_OPTIONS = [
  "Live music",
  "Art & galleries",
  "Theater",
  "Museums",
  "Food & dining",
  "Nightlife",
  "Running & fitness",
  "Yoga & wellness",
  "Cycling",
  "Hiking & parks",
  "Comedy",
  "Film & cinema",
  "Markets & shopping",
  "Books & readings",
  "Talks & lectures",
  "Dance",
  "Sports & games",
  "World Cup & Soccer",
  "Volunteering",
  "Photography",
  "Festivals & fireworks",
  "Family & kids",
  "Swimming & Water Activities",
  // Catch-all: events that don't match any other interest. Intentionally has NO entry in
  // INTEREST_KEYWORDS — it's handled in the plan route by matching events that match nothing
  // else (a negation of every other interest's keywords).
  "Others",
] as const

export type Interest = (typeof INTEREST_OPTIONS)[number]

// Maps each interest to category keywords used to PRE-FILTER events in the database
// before the AI curator runs. Matching is a case-insensitive substring match against
// the event's (short, controlled) `category` field, so a few extra terms improve recall
// without much risk of false positives. Keep keywords >= 3 chars to avoid noise.
export const INTEREST_KEYWORDS: Record<string, string[]> = {
  "Live music": ["music", "concert", "band", "jazz", "singer", "orchestra", "choir", "performance"],
  "Art & galleries": ["art", "gallery", "exhibit", "painting", "sculpture", "mural", "crafts"],
  Theater: ["theater", "theatre", "play", "drama", "musical", "broadway", "performance"],
  Museums: ["museum", "exhibit", "gallery", "history", "historic", "science", "astronomy"],
  "Food & dining": ["food", "dining", "tasting", "culinary", "cooking", "brunch"],
  Nightlife: ["nightlife", "club", "party", "dance"],
  "Running & fitness": [
    "run",
    "running",
    "fitness",
    "workout",
    "bootcamp",
    "marathon",
    "exercise",
    "strength",
    "weight",
    "training",
    "shape up",
  ],
  "Yoga & wellness": ["yoga", "wellness", "meditation", "mindfulness", "tai chi", "pilates"],
  Cycling: ["cycling", "bike", "bicycle", "ride"],
  "Hiking & parks": [
    "hike",
    "hiking",
    "park",
    "trail",
    "nature",
    "outdoor",
    "garden",
    "walk",
    "wildlife",
    "bird",
    "audubon",
    "waterfront",
    "climbing",
    "adventure",
    "tour",
  ],
  Comedy: ["comedy", "comedian", "standup", "improv"],
  "Film & cinema": ["film", "cinema", "movie", "screening"],
  "Markets & shopping": ["market", "shopping", "bazaar", "fair", "flea", "vendor"],
  "Books & readings": ["book", "reading", "author", "poetry", "literature", "library"],
  "Talks & lectures": ["talk", "lecture", "seminar", "panel", "discussion", "conversation", "keynote", "symposium"],
  Dance: ["dance", "ballet", "salsa", "tango", "choreography"],
  "Sports & games": [
    "sport",
    "game",
    "basketball",
    "soccer",
    "tennis",
    "baseball",
    "volleyball",
    "chess",
    "pickleball",
    "football",
    "recreation",
  ],
  // Matches the canonical WORLD_CUP_CATEGORY ("World Cup Viewing") assigned at ingest to
  // soccer/World Cup viewing events (watch parties, fan zones, big-screen screenings). The
  // canonical category has no "soccer"/"football" substring, so these events collect ONLY
  // here and are not double-listed under "Sports & games".
  "World Cup & Soccer": ["world cup"],
  Volunteering: ["volunteer", "cleanup", "charity", "stewardship"],
  Photography: ["photo", "photography", "camera"],
  "Festivals & fireworks": [
    "festival",
    "fireworks",
    "firework",
    "celebration",
    "parade",
    "holiday",
    "fourth of july",
    "independence",
    "new year",
  ],
  "Family & kids": ["kids", "kid", "family", "children", "child", "youth", "toddler", "teen", "seniors"],
  "Swimming & Water Activities": [
    "swim",
    "aquatic",
    "pool",
    "water",
    "kayak",
    "canoe",
    "paddle",
    "rowing",
    "sail",
    "boat",
    "raft",
    "surf",
    "fishing",
    "snorkel",
    "scuba",
    "diving",
  ],
}

// Who the user is choosing the activity for. Biases both the semantic-search embedding and
// the LLM curation (e.g. date-friendly spots for a couple, kid-friendly outings for family,
// low-key group-friendly venues for colleagues). All optional — "" means not provided.
// "any" is the sentinel for "not provided" across the optional preference fields below.
// (Radix Select items can't use an empty-string value, so we use "any" instead.)
export const COMPANY_OPTIONS = [
  { value: "any", label: "No preference" },
  { value: "solo", label: "Just me (solo)" },
  { value: "couple", label: "Couple" },
  { value: "family", label: "Family" },
  { value: "colleagues", label: "Colleagues (work)" },
  { value: "friends", label: "Friends" },
] as const

export type Company = (typeof COMPANY_OPTIONS)[number]["value"]

// Coarse age groups instead of an exact age. Used to tailor recommendations (e.g. nightlife
// vs. relaxed daytime outings). Optional — "any" means not provided.
export const AGE_GROUP_OPTIONS = [
  { value: "any", label: "No preference" },
  { value: "under-18", label: "Under 18" },
  { value: "18-24", label: "18–24" },
  { value: "25-34", label: "25–34" },
  { value: "35-44", label: "35–44" },
  { value: "45-54", label: "45–54" },
  { value: "55-64", label: "55–64" },
  { value: "65+", label: "65+" },
] as const

export type AgeGroup = (typeof AGE_GROUP_OPTIONS)[number]["value"]

// Alcohol preference. Biases the embedding and LLM toward (or away from) bars, breweries,
// wine tastings, and cocktail-forward events. Optional — "any" means not provided / mixed.
export const ALCOHOL_OPTIONS = [
  { value: "any", label: "No preference / mixed" },
  { value: "none", label: "Alcohol-free" },
  { value: "drinks", label: "Drinks please" },
] as const

export type AlcoholPreference = (typeof ALCOHOL_OPTIONS)[number]["value"]

export interface Profile {
  homeAddress: string
  officeAddress: string
  workStart: string // "09:00"
  workEnd: string // "17:00"
  workDays: WeekDay[]
  interests: string[]
  maxTravelMinutes: number
  budget: "free" | "low" | "medium" | "any"
  // Who the activity is being chosen for. Optional ("" = not provided).
  company: Company
  // Coarse age group of the person choosing. Optional ("" = not provided).
  ageGroup: AgeGroup
  // Alcohol preference. Optional ("" = not provided / mixed).
  alcohol: AlcoholPreference
  // When false, events whose location/travel time is only approximate (e.g. mapped to a
  // neighborhood centroid rather than an exact venue) are excluded from the plan.
  includeApproximateLocations: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  day: WeekDay
  start: string // "18:30"
  end: string // "20:00"
  source: "google"
}

export interface SpecialRequest {
  id: string
  text: string
}

export interface WeatherDay {
  date: string // ISO date
  day: WeekDay
  label: string // "Mon"
  high: number
  low: number
  condition: string
  precipProbability: number
  outdoorFriendly: boolean
}

export interface Activity {
  id: string
  title: string
  category: string
  date: string // ISO date "2026-06-24" — the actual calendar day, within the next 7 days
  day: WeekDay
  startTime: string
  endTime: string
  endDate?: string // ISO date when a multi-day event ends; used to show "Runs through …"
  venue: string
  neighborhood: string
  address: string
  priceLabel: string
  indoor: boolean
  url: string
  imageUrl?: string // optional event image from the catalog
  why: string
  travelNote: string
  travelFromHome: string // e.g. "~25 min by subway"
  travelFromOffice: string // e.g. "~15 min walk"
  approximateLocation?: boolean // true when travel time is based on an approximate location
}

export interface PlanSource {
  title: string
  url: string
  host: string
}

// One physical viewing SPOT (venue), aggregating all of its World Cup sessions into a single
// entry with a date span — used by the "Browse all World Cup viewing" list, which shows every
// place with viewing rather than a day-by-day itinerary.
export interface WorldCupSpot {
  id: string
  name: string // venue name, or the event title when no venue is set
  venue: string
  neighborhood: string
  address: string
  borough: string
  firstDate: string // ISO date of the earliest session
  lastDate: string // ISO date of the latest session (or multi-day end)
  dateSpanLabel: string // human label, e.g. "Jul 1 – Jul 2" or "Through Jul 19"
  sessions: number // how many individual viewing sessions map to this spot
  priceLabel: string
  indoor: boolean
  url: string
  imageUrl: string
  travelFromHome: string
  travelFromOffice: string
  approximateLocation: boolean
}

export interface WorldCupSpotsResult {
  summary: string
  spots: WorldCupSpot[]
  sources?: PlanSource[]
}

export interface WeeklyPlan {
  summary: string
  activities: Activity[]
  sources?: PlanSource[]
  // Present when the user selected the "World Cup & Soccer" interest. World Cup viewing is
  // location-first, not date-first, so these events are shown as aggregated viewing SPOTS
  // (each with a date span) instead of date-grouped activity cards.
  worldCup?: WorldCupSpotsResult
}

export const DEFAULT_PROFILE: Profile = {
  homeAddress: "",
  officeAddress: "",
  workStart: "09:00",
  workEnd: "17:00",
  workDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  interests: ["Live music", "Food & dining", "Art & galleries", "Running & fitness"],
  maxTravelMinutes: 40,
  budget: "any",
  company: "any",
  ageGroup: "any",
  alcohol: "any",
  includeApproximateLocations: true,
}
