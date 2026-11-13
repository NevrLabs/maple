import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { AtlasSnapshot } from "../model"

export const Message = defineMessageUnion({
	CompletedFetchSnapshot: { key: Schema.String, result: Schema.Result(AtlasSnapshot, LoadFailure) },
	/** Every 30 s while the page is open: Atlas is scraped every 30 s. */
	TickedRefresh: {},
	ClickedRetry: {},
})
export type Message = typeof Message.Type
