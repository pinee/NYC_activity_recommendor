import { NextResponse, type NextRequest } from "next/server"
import { buildAuthUrl, googleConfigured } from "@/lib/google"

export async function GET(req: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?gcal=unconfigured", req.nextUrl.origin))
  }
  const state = crypto.randomUUID()
  const authUrl = buildAuthUrl(req.nextUrl.origin, state)
  const res = NextResponse.redirect(authUrl)
  res.cookies.set("gcal_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  })
  return res
}
