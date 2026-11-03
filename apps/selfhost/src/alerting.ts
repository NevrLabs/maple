/**
 * Self-hosted alerting scheduler: replaces the Cloudflare cron triggers of apps/alerting.
 * Every cron in ALERTING_SCHEDULE fires `runScheduled(cron, lane, …)` (unmodified) for each lane,
 * lanes in parallel, each bounded by its schedule's deadline. A lane still running when its next
 * fire comes is skipped (no overlap). /health reports the last fire per cron.
 */
import { Cause, Duration, Effect, Option } from "effect"
import { ALERTING_SCHEDULE, type AlertingCron } from "../../alerting/src/schedule"
import { selfhostEnv, selfhostStatusBindings } from "./ports"
import { ensureStatusSchema, statusDb } from "./status-store"

const env = selfhostEnv()
// PATCHES #9: publish status pages into the Postgres store the status server reads.
const statusBindings = selfhostStatusBindings()
if (statusBindings !== null && process.env.MAPLE_PG_URL) await ensureStatusSchema(statusDb(process.env.MAPLE_PG_URL))
const statusPages = statusBindings === null ? Option.none() : Option.some(statusBindings)
const running = new Set<string>()
const lastFire: Record<string, { at: string; lanes: Record<string, string> }> = {}

/** Minimal 5-field cron matcher for the fixed schedules alerting declares (*, *\/n, n). */
const fieldMatches = (field: string, value: number) => {
	if (field === "*") return true
	const step = field.match(/^\*\/(\d+)$/)
	if (step) return value % Number(step[1]) === 0
	return field.split(",").some((part) => Number(part) === value)
}
const cronMatches = (cron: string, d: Date) => {
	const [min, hour, dom, mon, dow] = cron.split(" ")
	return (
		fieldMatches(min!, d.getUTCMinutes()) &&
		fieldMatches(hour!, d.getUTCHours()) &&
		fieldMatches(dom!, d.getUTCDate()) &&
		fieldMatches(mon!, d.getUTCMonth() + 1) &&
		fieldMatches(dow!, d.getUTCDay())
	)
}

const scheduledModule = import("../../alerting/src/scheduled")

const fire = async (cron: AlertingCron, at: Date) => {
	const { runScheduled } = await scheduledModule
	const schedule = ALERTING_SCHEDULE[cron]
	const record = (lastFire[cron] = { at: at.toISOString(), lanes: {} as Record<string, string> })
	await Promise.all(
		schedule.lanes.map(async (lane) => {
			const key = `${cron}|${lane}`
			if (running.has(key)) {
				record.lanes[lane] = "skipped-overlap"
				return
			}
			running.add(key)
			const started = Date.now()
			try {
				await Effect.runPromise(
					runScheduled(cron, lane, env, Option.none(), undefined as any, statusPages).pipe(
						Effect.timeout(Duration.fromInputUnsafe(schedule.deadline as Duration.Input)),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: Effect.logError("Alerting scheduled run failed", cause).pipe(
										Effect.annotateLogs({ "maple.alerting.cron": cron, "maple.alerting.lane": lane }),
									),
						),
						Effect.withSpan("alerting.lane", {
							attributes: { "maple.alerting.cron": cron, "maple.alerting.lane": lane, "maple.alerting.dispatch": "selfhost" },
						}),
					) as Effect.Effect<unknown, never, never>,
				)
				record.lanes[lane] = `ok ${Date.now() - started}ms`
			} catch (error) {
				record.lanes[lane] = `error ${String(error).slice(0, 120)}`
			} finally {
				running.delete(key)
			}
		}),
	)
}

const tick = () => {
	const now = new Date()
	now.setUTCSeconds(0, 0)
	for (const cron of Object.keys(ALERTING_SCHEDULE) as AlertingCron[]) {
		if (cronMatches(cron, now)) void fire(cron, now)
	}
}

// Align to the top of each minute.
const msToNextMinute = 60_000 - (Date.now() % 60_000)
setTimeout(() => {
	tick()
	setInterval(tick, 60_000)
}, msToNextMinute + 500)

Bun.serve({
	port: Number(process.env.PORT ?? 3480),
	hostname: "0.0.0.0",
	fetch(req) {
		const url = new URL(req.url)
		if (url.pathname === "/health") return Response.json({ ok: true, running: [...running], lastFire })
		// Manual trigger for verification: POST /fire?cron=* * * * *
		if (url.pathname === "/fire" && req.method === "POST") {
			const cron = url.searchParams.get("cron") as AlertingCron | null
			if (!cron || !(cron in ALERTING_SCHEDULE)) return new Response("unknown cron", { status: 400 })
			void fire(cron, new Date())
			return new Response("fired", { status: 202 })
		}
		return new Response("not found", { status: 404 })
	},
})
console.log(`maple-alerting (selfhost) scheduler up; crons: ${Object.keys(ALERTING_SCHEDULE).join(" | ")}`)
