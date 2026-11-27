/**
 * Self-hosted Twilio exporter (NevrLabs selfhost): polls Twilio's Messages and Calls logs and pushes
 * one OTLP log per record to Maple's ingest, so an undelivered SMS or a failed call is an error like
 * any other service's, alertable through error issues. Plain Bun, no Effect: one loop, one state file.
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, MAPLE_INGEST_URL (OTLP/HTTP base, e.g. http://ingest:3474),
 * MAPLE_TWILIO_TOKEN (a `twilio` source's token; falls back to MAPLE_INGEST_KEY), TWILIO_POLL_SECONDS (60),
 * TWILIO_STATE_PATH (/var/lib/maple-twilio/state.json), TWILIO_CALLS (on unless "off"), PORT (3479, /health).
 *
 * Message bodies are never read: a record carries its status, endpoints, error and price only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Record as Rec, String as Str } from "effect"
interface TwilioRecord {
	readonly sid: string
	readonly status: string
	readonly from?: string | null
	readonly to?: string | null
	readonly direction?: string | null
	readonly date_created?: string | null
	readonly date_sent?: string | null
	readonly date_updated?: string | null
	readonly start_time?: string | null
	readonly end_time?: string | null
	readonly error_code?: number | string | null
	readonly error_message?: string | null
	readonly price?: string | null
	readonly price_unit?: string | null
	readonly num_segments?: number | string | null
	readonly duration?: string | null
	readonly messaging_service_sid?: string | null
}

interface StreamState {
	/** ISO time of the newest record's creation already pushed; the next poll starts just before it. */
	readonly since: string | null
}

interface State {
	readonly messages: StreamState
	readonly calls: StreamState
	/** `sid|status|date_updated` of every record pushed, newest last: a status change is a new log. */
	readonly seen: ReadonlyArray<string>
}

const SEEN_MAX = 5000
/** Records created this long before the cursor are read again, so a late page is not skipped. */
const OVERLAP_MS = 5 * 60_000
const MAX_PAGES = 10
const PAGE_SIZE = 1000
const SEVERITY = { error: 17, warn: 13, info: 9 } as const

const env = (name: string): string | undefined => Str.trim(process.env[name] ?? "") || undefined

/** How a record's status reads in Maple: failures are errors, a call nobody took is a warning. */
export const severityOf = (kind: "message" | "call", status: string): keyof typeof SEVERITY => {
	if (status === "failed" || status === "undelivered") return "error"
	if (kind === "call" && (status === "busy" || status === "no-answer" || status === "canceled")) {
		return "warn"
	}
	return "info"
}

/** A phone number for a log line: country code and last four digits, the middle hidden. */
export const maskNumber = (number: string): string => {
	// "+62" and one more digit stay, the last four stay: the middle is the part that names a person.
	if (number.length <= 8) return number
	return `${Str.slice(0, 4)(number)}•••${Str.slice(number.length - 4)(number)}`
}

const text = (value: string | number | null | undefined): string =>
	value === null || value === undefined ? "" : `${value}`

const attribute = (key: string, value: string | number | null | undefined) =>
	value === null || value === undefined || value === ""
		? []
		: [{ key, value: { stringValue: text(value) } }]

/** One Twilio record as an OTLP log record; `event.name` says which log it came from. */
export const toLogRecord = (kind: "message" | "call", record: TwilioRecord) => {
	const prefix = `twilio.${kind}`
	const created = record.date_created ?? record.start_time ?? ""
	const sent = record.date_sent ?? record.start_time ?? null
	const status = record.status
	const isMessage = kind === "message"
	const latencyMs = sent !== null && created !== "" ? Date.parse(sent) - Date.parse(created) : null
	const severity = severityOf(kind, status)
	const error =
		record.error_code !== null && record.error_code !== undefined && record.error_code !== ""
			? ` (${text(record.error_code)}${record.error_message ? `: ${record.error_message}` : ""})`
			: ""
	const who = `${
		record.direction !== null &&
		record.direction !== undefined &&
		Str.includes("inbound")(record.direction)
			? "from"
			: "to"
	} ${maskNumber(record.to ?? record.from ?? "")}`
	const body = isMessage
		? `SMS ${who} ${status}${error}`
		: `Call ${who} ${status} (${text(record.duration ?? "0")}s)${error}`
	const timeUnixNano = `${BigInt(Date.parse(record.date_updated ?? (created || `${Date.now()}`))) * 1_000_000n}`
	return {
		timeUnixNano,
		severityNumber: SEVERITY[severity],
		severityText: severity === "info" ? "INFO" : severity === "warn" ? "WARN" : "ERROR",
		body: { stringValue: body },
		attributes: [
			{ key: "event.name", value: { stringValue: prefix } },
			{ key: "twilio.sid", value: { stringValue: record.sid } },
			{ key: "twilio.status", value: { stringValue: status } },
			...attribute("twilio.direction", record.direction),
			...attribute("twilio.from", record.from),
			...attribute("twilio.to", record.to),
			...attribute("twilio.error_code", record.error_code),
			...attribute("twilio.error_message", record.error_message),
			...attribute("twilio.price", record.price),
			...attribute("twilio.price_unit", record.price_unit),
			...attribute("twilio.account_sid", env("TWILIO_ACCOUNT_SID")),
			...(isMessage
				? [
						...attribute("twilio.message.messaging_service_sid", record.messaging_service_sid),
						...attribute("twilio.message.segments", record.num_segments),
						...attribute("twilio.message.latency_ms", latencyMs),
					]
				: [...attribute("twilio.call.duration", record.duration)]),
		],
	}
}

/** The OTLP/HTTP JSON envelope of a batch, as the `service.name` Maple groups the records under. */
export const toOtlpLogs = (records: ReadonlyArray<ReturnType<typeof toLogRecord>>) => ({
	resourceLogs: [
		{
			resource: {
				attributes: [
					{ key: "service.name", value: { stringValue: "twilio" } },
					{ key: "service.version", value: { stringValue: env("COMMIT_SHA") ?? "" } },
				],
			},
			scopeLogs: [{ scope: { name: "maple-twilio-exporter" }, logRecords: [...records] }],
		},
	],
})

const dayOf = (iso: string): string => Str.slice(0, 10)(iso)

/** The records of one poll: new ones, and older ones whose status changed, newest first. */
export const selectNew = (
	records: ReadonlyArray<TwilioRecord>,
	since: string | null,
	seen: ReadonlySet<string>,
): ReadonlyArray<TwilioRecord> => {
	const floor = since === null ? 0 : Date.parse(since) - OVERLAP_MS
	const chosen: Array<TwilioRecord> = []
	for (const record of records) {
		const created = Date.parse(record.date_created ?? record.start_time ?? "")
		if (!Number.isFinite(created) || created < floor) continue
		if (seen.has(`${record.sid}|${record.status}|${record.date_updated ?? ""}`)) continue
		chosen.push(record)
	}
	return chosen
}

const keyOf = (record: TwilioRecord) => `${record.sid}|${record.status}|${record.date_updated ?? ""}`

const EMPTY_STATE: State = { messages: { since: null }, calls: { since: null }, seen: [] }

/** The last tick's state, or an empty one: a missing or damaged file only costs a fresh lookback. */
export const readState = (path: string | undefined): State => {
	if (path === undefined) return EMPTY_STATE
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>
		return {
			messages: { since: parsed.messages?.since ?? null },
			calls: { since: parsed.calls?.since ?? null },
			seen: parsed.seen ?? [],
		}
	} catch {
		return EMPTY_STATE
	}
}

/** Written whole through a temporary file, so a stop mid-write leaves the last good state. */
export const writeState = (path: string | undefined, state: State) => {
	if (path === undefined) return
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(`${path}.tmp`, JSON.stringify(state))
	renameSync(`${path}.tmp`, path)
}

const twilioGet = async (
	sid: string,
	auth: string,
	path: string,
	query: Record<string, string>,
): Promise<{ status: number; body: { [key: string]: unknown } }> => {
	const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`)
	for (const [key, value] of Rec.toEntries(query)) url.searchParams.set(key, value)
	const response = await fetch(url, {
		headers: {
			authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
			accept: "application/json",
		},
		// A redirect is not Twilio answering, so the credentials never follow one.
		redirect: "manual",
	})
	return {
		status: response.status,
		body: (await response.json().catch(() => ({}))) as { [key: string]: unknown },
	}
}

/** One page of a log list; `null` when Twilio refused, so the caller keeps its cursor. */
const listPage = async (
	sid: string,
	auth: string,
	kind: "message" | "call",
	dayParam: string,
	day: string,
	page: number,
): Promise<{ records: ReadonlyArray<TwilioRecord>; more: boolean } | null> => {
	const answer = await twilioGet(sid, auth, kind === "message" ? "/Messages.json" : "/Calls.json", {
		PageSize: `${PAGE_SIZE}`,
		Page: `${page}`,
		[dayParam]: day,
	})
	if (answer.status >= 300) {
		console.error(`twilio ${kind} list answered ${answer.status}: ${text(answer.body.message)}`)
		return null
	}
	const key = kind === "message" ? "messages" : "calls"
	const records = (answer.body[key] as ReadonlyArray<TwilioRecord> | undefined) ?? []
	const next = answer.body.next_page_uri
	return { records, more: typeof next === "string" && next !== "" }
}

interface Poll {
	readonly pushed: number
	readonly state: State
}

const pollStream = async (
	kind: "message" | "call",
	state: State,
	sid: string,
	auth: string,
	lookbackMs: number,
): Promise<{ chosen: ReadonlyArray<TwilioRecord>; state: State } | null> => {
	const stream = kind === "message" ? state.messages : state.calls
	const since = stream.since ?? new Date(Date.now() - lookbackMs).toISOString()
	const dayParam = kind === "message" ? "DateSent>=" : "StartTime>="
	const collected: Array<TwilioRecord> = []
	const seen = new Set(state.seen)
	for (let page = 0; page < MAX_PAGES; page++) {
		const answer = await listPage(sid, auth, kind, dayParam, dayOf(since), page)
		if (answer === null) return null
		collected.push(...answer.records)
		// The list is newest first: a page that reaches before the cursor is the last one read.
		const oldest = answer.records[answer.records.length - 1]
		const reached =
			oldest !== undefined &&
			Date.parse(oldest.date_created ?? oldest.start_time ?? "") < Date.parse(since) - OVERLAP_MS
		if (!answer.more || reached) break
	}
	const chosen = selectNew(collected, since, seen)
	const newest = chosen.reduce(
		(best, record) =>
			Date.parse(record.date_created ?? record.start_time ?? "") > Date.parse(best)
				? (record.date_created ?? record.start_time ?? best)
				: best,
		since,
	)
	for (const record of chosen) seen.add(keyOf(record))
	const nextSeen = [...seen].slice(-SEEN_MAX)
	return {
		chosen,
		state:
			kind === "message"
				? { ...state, seen: nextSeen, messages: { since: newest } }
				: { ...state, seen: nextSeen, calls: { since: newest } },
	}
}

const push = async (url: string, token: string, records: ReadonlyArray<ReturnType<typeof toLogRecord>>) => {
	const response = await fetch(`${Str.replace(/\/$/, "")(url)}/v1/logs`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(toOtlpLogs(records)),
	})
	return response.status
}

/** One tick: both logs read, one push, the state advanced only when Maple took the batch. */
const tick = async (config: Config, state: State): Promise<State> => {
	const messages = await pollStream("message", state, config.sid, config.auth, config.lookbackMs)
	if (messages === null) return state
	const calls = config.calls
		? await pollStream("call", messages.state, config.sid, config.auth, config.lookbackMs)
		: { chosen: [], state: messages.state }
	if (calls === null) return state
	const records = [
		...messages.chosen.map((record) => toLogRecord("message", record)),
		...calls.chosen.map((record) => toLogRecord("call", record)),
	]
	if (records.length === 0) return calls.state
	const status = await push(config.ingestUrl, config.token, records)
	if (status >= 300) {
		console.error(
			`maple ingest answered ${status} for ${records.length} Twilio records; retrying next tick`,
		)
		return state
	}
	console.log(`twilio: pushed ${messages.chosen.length} messages, ${calls.chosen.length} calls`)
	return calls.state
}

interface Config {
	readonly sid: string
	readonly auth: string
	readonly ingestUrl: string
	readonly token: string
	readonly pollMs: number
	readonly statePath: string | undefined
	readonly lookbackMs: number
	readonly calls: boolean
}

const main = async () => {
	const sid = env("TWILIO_ACCOUNT_SID")
	const auth = env("TWILIO_AUTH_TOKEN")
	const ingestUrl = env("MAPLE_INGEST_URL")
	const token = env("MAPLE_TWILIO_TOKEN") ?? env("MAPLE_INGEST_KEY")
	if (!sid || !auth || !ingestUrl || !token) {
		console.error(
			"twilio exporter: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, MAPLE_INGEST_URL and MAPLE_TWILIO_TOKEN (or MAPLE_INGEST_KEY)",
		)
		process.exit(1)
	}
	const config: Config = {
		sid,
		auth,
		ingestUrl,
		token,
		pollMs: Number(env("TWILIO_POLL_SECONDS") ?? 60) * 1000,
		statePath: env("TWILIO_STATE_PATH"),
		lookbackMs: Number(env("TWILIO_LOOKBACK_HOURS") ?? 24) * 3_600_000,
		calls: Str.toLowerCase(env("TWILIO_CALLS") ?? "on") !== "off",
	}
	Bun.serve({
		port: Number(env("PORT") ?? 3479),
		hostname: "0.0.0.0",
		fetch(request) {
			return new URL(request.url).pathname === "/health"
				? new Response("ok")
				: new Response("not found", { status: 404 })
		},
	})
	let state = readState(config.statePath)
	for (;;) {
		const before = state
		state = await tick(config, state)
		if (state !== before) writeState(config.statePath, state)
		await Bun.sleep(config.pollMs)
	}
}

if (import.meta.main) void main()
