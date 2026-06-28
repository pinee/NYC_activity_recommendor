import { NextResponse } from "next/server"
import { COOKIE_ACCESS, COOKIE_EXPIRY, COOKIE_REFRESH } from "@/lib/google"

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE_ACCESS)
  res.cookies.delete(COOKIE_REFRESH)
  res.cookies.delete(COOKIE_EXPIRY)
  return res
}
