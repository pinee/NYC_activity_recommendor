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
  "Dance",
  "Sports & games",
  "Volunteering",
  "Photography",
] as const

export type Interest = (typeof INTEREST_OPTIONS)[number]

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
}
