import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { loadAtlasSnapshot } from "../data"
import { Message } from "./message"

/** The three raw-SQL reads at the current time, as one snapshot. */
export const FetchSnapshot = Command.define("FetchAtlasSnapshot", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSnapshot],
	execute: ({ key }) =>
		Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
			Effect.map(loadAtlasSnapshot(nowMs), (result) => Message.CompletedFetchSnapshot({ key, result })),
		),
})
