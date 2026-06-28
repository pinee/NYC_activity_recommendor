"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Loader2, MapPin } from "lucide-react"
import { Input } from "@/components/ui/input"

interface Suggestion {
  id: string
  label: string
}

interface Props {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function AddressAutocomplete({ id, value, onChange, placeholder }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  // Tracks the value we just selected so we don't immediately re-query for it.
  const justSelected = useRef(false)
  const listboxId = useId()

  useEffect(() => {
    if (justSelected.current) {
      justSelected.current = false
      return
    }
    const query = value.trim()
    if (query.length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        if (cancelled) return
        setSuggestions(data.suggestions ?? [])
        setOpen((data.suggestions ?? []).length > 0)
        setActiveIndex(-1)
      } catch {
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value])

  // Close on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [])

  const select = (label: string) => {
    justSelected.current = true
    onChange(label)
    setOpen(false)
    setSuggestions([])
    setActiveIndex(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault()
      select(suggestions[activeIndex].label)
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {loading && (
        <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onClick={() => select(s.label)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-secondary"
                }`}
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                <span className="leading-snug">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
