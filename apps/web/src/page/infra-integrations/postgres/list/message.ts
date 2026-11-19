import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { PostgresSnapshot } from "../model"

export const Message = defineMessageUnion({
	CompletedFetchSnapshot: { key: Schema.String, result: Schema.Result(PostgresSnapshot, LoadFailure) },
	/** Every 30 s while the page is open (the receiver collects every 60 s). */
	TickedRefresh: {},
	ClickedRetry: {},
})
export type Message = typeof Message.Type
