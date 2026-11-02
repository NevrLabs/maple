import { Effect, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { GuestScope, Tab } from "../../page/infra-integrations/proxmox/model"
import type { Resources } from "../../platform/resources"

// `/lab/proxmox`: a Pulse-style Proxmox page (node cards, guest table, storage bars, backups) over
// a real FxCluster snapshot. The floating lab toolbar switches the data state for review.

export { TAB_LABEL, TABS } from "../../page/infra-integrations/proxmox/model"
export { GuestScope, Tab }

/** Review states: the live snapshot, the first paint, one node gone silent, nothing reporting yet. */
export const LAB_STATES = ["live", "loading", "offline", "empty"] as const
export const LabState = Schema.Literals(LAB_STATES)
export type LabState = typeof LabState.Type
export const STATE_LABEL = {
	live: "Live snapshot",
	loading: "Loading",
	offline: "Node offline",
	empty: "No data",
} as const


export const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	tab: Tab,
	state: LabState,
	query: Schema.String,
	guestScope: Schema.optional(GuestScope),
	/** Node card pressed: the guest table narrows to that node. */
	nodeFilter: Schema.optional(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedTab: { tab: Tab },
	ClickedLabState: { state: LabState },
	ChangedQuery: { value: Schema.String },
	ChangedGuestScope: { scope: Schema.optional(GuestScope) },
	ClickedNode: { node: Schema.String },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

export const flags: Effect.Effect<Flags> = Effect.sync(() => {
	const url = new URL(location.href)
	return {
		nowMs: Date.now(),
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		...(url.searchParams.has("now") ? { nowMs: Number(url.searchParams.get("now")) } : {}),
	}
})

/** `?tab=` and `?state=` preselect, so every review screenshot has a stable URL. */
export const init = (flags: Flags): Return => {
	const url = new URL(location.href)
	const tab = url.searchParams.get("tab")
	const state = url.searchParams.get("state")
	const scope = url.searchParams.get("scope")
	return {
		model: {
			...flags,
			tab: Schema.is(Tab)(tab) ? tab : "overview",
			state: Schema.is(LabState)(state) ? state : "live",
			query: url.searchParams.get("q") ?? "",
			guestScope: Schema.is(GuestScope)(scope) ? scope : undefined,
			nodeFilter: url.searchParams.get("node") ?? undefined,
		},
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedTab: ({ tab }) => ({ model: { ...model, tab } }),
		ClickedLabState: ({ state }) => ({ model: { ...model, state } }),
		ChangedQuery: ({ value }) => ({ model: { ...model, query: value } }),
		ChangedGuestScope: ({ scope }) => ({ model: { ...model, guestScope: scope } }),
		ClickedNode: ({ node }) => ({
			model: { ...model, nodeFilter: model.nodeFilter === node ? undefined : node, tab: "overview" },
		}),
	})
