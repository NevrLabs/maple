// A fake Twilio for tests: the account resource and the daily usage records answered from a mutable
// world, with every API call recorded. Like the real API it filters records by date, pages them by
// `Page`, and names the next page until the last.
import { Layer, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"

// Split so secret scanners do not read a fake Account SID as a live one.
export const FAKE_TWILIO_SID = "AC" + "0123456789abcdef0123456789abcdef"

/** One day's charge of one category. */
export interface FakeRecord {
	readonly day: string
	readonly category: string
	readonly cents: number
	readonly description?: string | null
	readonly count?: number
	readonly countUnit?: string | null
	readonly priceUnit?: string | null
}

export interface FakeTwilio {
	/** Status of every usage call. */
	status: number
	/** Status of the account resource; the credential check reads it first. */
	accountStatus: number
	/** The account the credential opens: another SID stands for another account. */
	accountSid: string
	accountName: string | null
	/** Every usage record Twilio holds, or raw text for a malformed answer. */
	records: ReadonlyArray<FakeRecord> | string
	/** Records one page holds at most, below what the request's `PageSize` asks for. */
	pageSize: number
	readonly urls: Array<string>
	/** The Basic credentials of every call, as sent. */
	readonly basics: Array<string | null>
}

export const makeFakeTwilio = (overrides: Partial<FakeTwilio> = {}): FakeTwilio => ({
	status: 200,
	accountStatus: 200,
	accountSid: FAKE_TWILIO_SID,
	accountName: "NevrLabs",
	records: [],
	pageSize: 500,
	urls: [],
	basics: [],
	...overrides,
})

/** A record as the API's `UsageRecord`, with the fields Maple does not read. */
const wireOf = (record: FakeRecord) => ({
	category: record.category,
	description: record.description ?? null,
	start_date: record.day,
	end_date: record.day,
	usage: `${record.count ?? 1}`,
	usage_unit: record.countUnit ?? "messages",
	count: `${record.count ?? 1}`,
	count_unit: record.countUnit ?? "messages",
	price: (-record.cents / 100).toFixed(4),
	price_unit: record.priceUnit ?? "USD",
	as_of: null,
})

const refused = (status: number) =>
	Response.json({ code: status, message: "Refused", more_info: "" }, { status: status })

const fetchStub =
	(world: FakeTwilio): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		const headers = new Headers(init?.headers)
		world.basics.push(headers.get("authorization"))
		world.urls.push(`${url.pathname}${url.search}`)
		const segments = Str.split("/")(url.pathname)
		// `/2010-04-01/Accounts/<sid>.json`; every other read is the usage records under it.
		const accountPath = segments[2] === "Accounts" && segments.length === 4
		if (accountPath) {
			if (world.accountStatus !== 200) return refused(world.accountStatus)
			return Response.json({ sid: world.accountSid, friendly_name: world.accountName })
		}
		if (world.status !== 200) return refused(world.status)
		if (typeof world.records === "string") return new Response(world.records, { status: 200 })
		const startDate = url.searchParams.get("StartDate") ?? ""
		const endDate = url.searchParams.get("EndDate") ?? ""
		const size = Math.min(world.pageSize, Number(url.searchParams.get("PageSize") ?? "500"))
		const page = Number(url.searchParams.get("Page") ?? "0")
		const held = Arr.filter(world.records, (record) => record.day >= startDate && record.day <= endDate)
		const slice = Arr.take(Arr.drop(held, page * size), size)
		const more = (page + 1) * size < held.length
		return Response.json({
			usage_records: Arr.map(slice, wireOf),
			next_page_uri: more ? `${url.pathname}?Page=${page + 1}` : null,
		})
	}

/** Everything the Twilio cost services need, over the fake and a test database. */
export const fakeTwilioDeps = (testDb: TestDb, world: FakeTwilio) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, testDb.layer, Env.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig()),
	)
