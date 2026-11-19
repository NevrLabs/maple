import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { loadPostgresSnapshot } from "../data"
import { Message } from "./message"

/** The three raw-SQL reads at the current time, as one snapshot. */
export const FetchSnapshot = Command.define("FetchPostgresSnapshot", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSnapshot],
	execute: ({ key }) =>
		Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
			Effect.map(loadPostgresSnapshot(nowMs), (result) => Message.CompletedFetchSnapshot({ key, result })),
		),
})
