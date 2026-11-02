import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { loadProxmoxSnapshot } from "../data"
import { Message } from "./message"

/** The six raw-SQL reads at the current time, as one snapshot. */
export const FetchSnapshot = Command.define("FetchProxmoxSnapshot", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSnapshot],
	execute: ({ key }) =>
		Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
			Effect.map(loadProxmoxSnapshot(nowMs), (result) => Message.CompletedFetchSnapshot({ key, result })),
		),
})
