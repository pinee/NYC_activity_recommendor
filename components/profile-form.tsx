"use client"

import { Home, Building2, Clock, Compass, Check, MapPin, Users } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AddressAutocomplete } from "@/components/address-autocomplete"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AGE_GROUP_OPTIONS,
  ALCOHOL_OPTIONS,
  COMPANY_OPTIONS,
  INTEREST_OPTIONS,
  WEEK_DAYS,
  type Profile,
  type WeekDay,
} from "@/lib/types"
import { cn } from "@/lib/utils"

interface Props {
  profile: Profile
  onChange: (next: Profile) => void
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-accent bg-accent text-accent-foreground"
          : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

export function ProfileForm({ profile, onChange }: Props) {
  const toggleDay = (day: WeekDay) => {
    const has = profile.workDays.includes(day)
    onChange({
      ...profile,
      workDays: has ? profile.workDays.filter((d) => d !== day) : [...profile.workDays, day],
    })
  }

  const toggleInterest = (interest: string) => {
    const has = profile.interests.includes(interest)
    onChange({
      ...profile,
      interests: has
        ? profile.interests.filter((i) => i !== interest)
        : [...profile.interests, interest],
    })
  }

  return (
    <div className="flex flex-col gap-7">
      {/* Locations */}
      <section className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="home" className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Home className="size-3.5" /> Home address
          </Label>
          <AddressAutocomplete
            id="home"
            placeholder="e.g. 200 Bedford Ave, Brooklyn"
            value={profile.homeAddress}
            onChange={(v) => onChange({ ...profile, homeAddress: v })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="office" className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Building2 className="size-3.5" /> Office address
          </Label>
          <AddressAutocomplete
            id="office"
            placeholder="e.g. 350 5th Ave, Manhattan"
            value={profile.officeAddress}
            onChange={(v) => onChange({ ...profile, officeAddress: v })}
          />
        </div>
      </section>

      {/* Working hours */}
      <section className="flex flex-col gap-4">
        <Label className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Clock className="size-3.5" /> Working hours
        </Label>
        <div className="flex items-center gap-3">
          <Input
            type="time"
            aria-label="Work start time"
            value={profile.workStart}
            onChange={(e) => onChange({ ...profile, workStart: e.target.value })}
            className="w-32"
          />
          <span className="text-muted-foreground">to</span>
          <Input
            type="time"
            aria-label="Work end time"
            value={profile.workEnd}
            onChange={(e) => onChange({ ...profile, workEnd: e.target.value })}
            className="w-32"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {WEEK_DAYS.map((day) => (
            <Chip key={day} active={profile.workDays.includes(day)} onClick={() => toggleDay(day)}>
              {day.slice(0, 3)}
            </Chip>
          ))}
        </div>
      </section>

      {/* Interests */}
      <section className="flex flex-col gap-3">
        <Label className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Compass className="size-3.5" /> Interests <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>
        </Label>
        <div className="flex flex-wrap gap-2">
          {INTEREST_OPTIONS.map((interest) => (
            <Chip
              key={interest}
              active={profile.interests.includes(interest)}
              onClick={() => toggleInterest(interest)}
            >
              {interest}
            </Chip>
          ))}
        </div>
      </section>

      {/* About you: who you're choosing for, age group, alcohol — all optional */}
      <section className="flex flex-col gap-3">
        <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Users className="size-3.5" /> About you <span className="normal-case tracking-normal">(optional — helps us pick)</span>
        </span>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="company" className="text-xs text-muted-foreground">
              Choosing for
            </Label>
            <Select
              value={profile.company}
              onValueChange={(v) => onChange({ ...profile, company: v as Profile["company"] })}
            >
              <SelectTrigger id="company">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPANY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ageGroup" className="text-xs text-muted-foreground">
              Age group
            </Label>
            <Select
              value={profile.ageGroup}
              onValueChange={(v) => onChange({ ...profile, ageGroup: v as Profile["ageGroup"] })}
            >
              <SelectTrigger id="ageGroup">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGE_GROUP_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="alcohol" className="text-xs text-muted-foreground">
              Alcohol
            </Label>
            <Select
              value={profile.alcohol}
              onValueChange={(v) => onChange({ ...profile, alcohol: v as Profile["alcohol"] })}
            >
              <SelectTrigger id="alcohol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALCOHOL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {/* Travel + budget */}
      <section className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Max travel</Label>
            <span className="text-sm font-medium">{profile.maxTravelMinutes} min</span>
          </div>
          <Slider
            min={10}
            max={90}
            step={5}
            value={[profile.maxTravelMinutes]}
            onValueChange={(v) =>
              onChange({ ...profile, maxTravelMinutes: Array.isArray(v) ? v[0] : v })
            }
          />
        </div>
        <div className="flex flex-col gap-3">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Budget</Label>
          <Select
            value={profile.budget}
            onValueChange={(v) => onChange({ ...profile, budget: v as Profile["budget"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="free">Free only</SelectItem>
              <SelectItem value="low">Low ($)</SelectItem>
              <SelectItem value="medium">Medium ($$)</SelectItem>
              <SelectItem value="any">Any</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* Approximate locations toggle */}
      <section>
        <button
          type="button"
          role="checkbox"
          aria-checked={profile.includeApproximateLocations}
          onClick={() =>
            onChange({ ...profile, includeApproximateLocations: !profile.includeApproximateLocations })
          }
          className="flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground/30"
        >
          <span
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
              profile.includeApproximateLocations
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-background text-transparent",
            )}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <MapPin className="size-3.5 text-muted-foreground" /> Include events with approximate travel times
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Some events (e.g. newsletter picks) only give a neighborhood, so travel times are estimated. Uncheck to
              show only events with an exact venue.
            </span>
          </span>
        </button>
      </section>
    </div>
  )
}
