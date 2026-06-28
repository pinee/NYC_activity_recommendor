import { NextResponse, type NextRequest } from "next/server"
import {
  COOKIE_ACCESS,
  COOKIE_EXPIRY,
  COOKIE_REFRESH,
  exchangeCodeForTokens,
} from "@/lib/google"

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")
  const savedState = req.cookies.get("gcal_state")?.value

  if (error || !code) {
    return NextResponse.redirect(new URL("/?gcal=error", origin))
  }
  if (!state || state !== savedState) {
    return NextResponse.redirect(new URL("/?gcal=state_mismatch", origin))
  }

  const tokens = await exchangeCodeForTokens(code, origin)
  if (tokens.error || !tokens.access_token) {
    return NextResponse.redirect(new URL("/?gcal=token_error", origin))
  }

  const res = NextResponse.redirect(new URL("/?gcal=connected", origin))
  const secureOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
  }

  res.cookies.set(COOKIE_ACCESS, tokens.access_token, {
    ...secureOpts,
    maxAge: tokens.expires_in ?? 3600,
  })
  res.cookies.set(COOKIE_EXPIRY, String(Date.now() + (tokens.expires_in ?? 3600) * 1000), {
    ...secureOpts,
    maxAge: 60 * 60 * 24 * 30,
  })
  if (tokens.refresh_token) {
    res.cookies.set(COOKIE_REFRESH, tokens.refresh_token, {
      ...secureOpts,
      maxAge: 60 * 60 * 24 * 30,
    })
  }
  res.cookies.delete("gcal_state")
  return res
}
