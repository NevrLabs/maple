import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { GuestScope, ProxmoxSnapshot, Tab } from "../model"

export const Message = defineMessageUnion({
	CompletedFetchSnapshot: { key: Schema.String, result: Schema.Result(ProxmoxSnapshot, LoadFailure) },
	/** Every 30 s while the page is open: PVE pushes every ~10 s, the backups collector every 15 min. */
	TickedRefresh: {},
	ClickedRetry: {},
	ClickedTab: { tab: Tab },
	ChangedQuery: { value: Schema.String },
	ChangedGuestScope: { scope: Schema.optional(GuestScope) },
	ClickedNode: { node: Schema.String },
})
export type Message = typeof Message.Type
