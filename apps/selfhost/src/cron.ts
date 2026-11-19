// NevrLabs selfhost: the cron matcher behind the Bun alerting scheduler (alerting.ts).

/** Minimal 5-field cron matcher for the fixed schedules alerting declares (*, *\/n, a-b/n, n, a,b). */
const fieldMatches = (field: string, value: number) =>
	field.split(",").some((part) => {
		const [range, stepRaw] = part.split("/")
		const step = stepRaw === undefined ? 1 : Number(stepRaw)
		const [lo, hi] = range === "*" ? [0, Infinity] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), stepRaw === undefined ? Number(range) : Infinity]
		return value >= lo! && value <= hi! && (value - lo!) % step === 0
	})
export const cronMatches = (cron: string, d: Date) => {
	const [min, hour, dom, mon, dow] = cron.split(" ")
	return (
		fieldMatches(min!, d.getUTCMinutes()) &&
		fieldMatches(hour!, d.getUTCHours()) &&
		fieldMatches(dom!, d.getUTCDate()) &&
		fieldMatches(mon!, d.getUTCMonth() + 1) &&
		fieldMatches(dow!, d.getUTCDay())
	)
}
