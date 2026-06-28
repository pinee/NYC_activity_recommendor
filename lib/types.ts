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
  "Coffee & cafes",
  "Nightlife",
  "Running & fitness",
  "Yoga & wellness",
  "Cycling",
  "Hiking & parks",
  "Comedy",
  "Film & cinema",
  "Markets & shopping",
  "Tech & startups",
  "Books & readings",
  "Talks & lectures",
  "Dance",
  "Sports & games",
  "Volunteering",
  "Photography",
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
  Museums: ["museum", "exhibit", "gallery", "history", "science"],
  "Food & dining": ["food", "dining", "tasting", "culinary", "cooking", "brunch"],
  "Coffee & cafes": ["coffee", "cafe", "espresso", "tea"],
  Nightlife: ["nightlife", "club", "party", "dance"],
  "Running & fitness": ["run", "running", "fitness", "workout", "bootcamp", "marathon", "exercise"],
  "Yoga & wellness": ["yoga", "wellness", "meditation", "mindfulness", "tai chi", "pilates"],
  Cycling: ["cycling", "bike", "bicycle", "ride"],
  "Hiking & parks": ["hike", "hiking", "park", "trail", "nature", "outdoor", "garden", "walk"],
  Comedy: ["comedy", "comedian", "standup", "improv"],
  "Film & cinema": ["film", "cinema", "movie", "screening"],
  "Markets & shopping": ["market", "shopping", "bazaar", "fair", "flea", "vendor"],
  "Tech & startups": ["tech", "startup", "coding", "hackathon", "developer"],
  "Books & readings": ["book", "reading", "author", "poetry", "literature", "library"],
  "Talks & lectures": ["talk", "lecture", "seminar", "panel", "discussion", "conversation", "keynote", "symposium"],
  Dance: ["dance", "ballet", "salsa", "tango", "choreography"],
  "Sports & games": ["sport", "game", "basketball", "soccer", "tennis", "baseball", "volleyball", "chess", "pickleball"],
  Volunteering: ["volunteer", "cleanup", "charity", "stewardship"],
  Photography: ["photo", "photography", "camera"],
}

export interface Profile {
  homeAddress: string
  officeAddress: string
  workStart: string // "09:00"
  workEnd: string // "17:00"
  workDays: WeekDay[]
  interests: string[]
  // 1 = stick to my core interests, 5 = surprise me with variety
  diversity: number
  maxTravelMinutes: number
  budget: "free" | "low" | "medium" | "any"
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
  source: "google" | "manual"
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

export interface WeeklyPlan {
  summary: string
  activities: Activity[]
  sources?: PlanSource[]
  // Set when deterministic filters (budget / working hours / travel) removed events
  // the AI had otherwise selected, e.g. "3 events hidden: 2 too far, 1 over budget."
  filteredNote?: string
}

export const DEFAULT_PROFILE: Profile = {
  homeAddress: "",
  officeAddress: "",
  workStart: "09:00",
  workEnd: "17:00",
  workDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  interests: ["Live music", "Food & dining", "Art & galleries", "Running & fitness"],
  diversity: 3,
  maxTravelMinutes: 40,
  budget: "any",
  includeApproximateLocations: true,
}
