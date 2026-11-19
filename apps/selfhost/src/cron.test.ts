import { describe, expect, test } from "bun:test"
import { ALERTING_SCHEDULE } from "../../alerting/src/schedule"
import { cronMatches } from "./cron"

// NevrLabs selfhost: every cron alerting declares must fire here, or its lanes silently never run
// (`2-59/5` once matched nothing, so cost_sync, vercel and aws_security never ran self-hosted).
const at = (minute: number, hour = 3) => new Date(Date.UTC(2026, 10, 19, hour, minute))
const minutesFiring = (cron: string) => Array.from({ length: 60 }, (_, m) => m).filter((m) => cronMatches(cron, at(m)))

describe("cronMatches", () => {
	test("every declared schedule fires at least once an hour", () => {
		for (const cron of Object.keys(ALERTING_SCHEDULE)) expect(minutesFiring(cron).length).toBeGreaterThan(0)
	})
	test("forms alerting uses", () => {
		expect(minutesFiring("* * * * *")).toHaveLength(60)
		expect(minutesFiring("*/15 * * * *")).toEqual([0, 15, 30, 45])
		expect(minutesFiring("2-59/5 * * * *")).toEqual([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57])
		expect(minutesFiring("0 * * * *")).toEqual([0])
		expect(minutesFiring("10,40 * * * *")).toEqual([10, 40])
		expect(minutesFiring("5-7 * * * *")).toEqual([5, 6, 7])
		expect(cronMatches("0 3 * * *", at(0, 3))).toBe(true)
		expect(cronMatches("0 3 * * *", at(0, 4))).toBe(false)
	})
})
