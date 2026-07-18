import { embedMissingEvents } from "@/lib/embed-events"

// One-shot backfill endpoint: embeds a batch of events that don't yet have a semantic-search
// embedding and reports how many remain, so a caller can poll it until `remaining` is 0.
// Kept small per call (default 300) to stay within the function time limit. Protected by the
// same CRON_SECRET as the ingest job when one is configured.
export const maxDuration = 300

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // no secret configured (e.g. local/dev) — allow
  return req.headers.get("authorization") === `Bearer ${secret}`
}

async function run(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  const url = new URL(req.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 300, 1), 500)
  try {
    const result = await embedMissingEvents(limit)
    return Response.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[v0] embeddings backfill error:", message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(req: Request) {
  return run(req)
}

export async function POST(req: Request) {
  return run(req)
}
