import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { apiBaseUrl } from "../../../lib/services/common/api-base-url"
import { readSessionToken } from "../../../platform/auth-api"
import type { PageReturn } from "../../contract"
import { Message, type Model, type UserAction, UserRow, UsersList } from "./model"

type Return = PageReturn<Model, Message>

/** A plain fetch with the tab's session bearer: these fork-only endpoints are not in the typed HttpApi. */
const call = <A>(method: "GET" | "POST", path: string, schema: Schema.Codec<A, unknown>) =>
	Effect.gen(function* () {
		const token = Option.getOrElse(yield* readSessionToken, () => "")
		const response = yield* Effect.tryPromise(() =>
			fetch(`${apiBaseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}` } }),
		)
		const body: unknown = yield* Effect.tryPromise(() => response.json())
		if (!response.ok) return yield* Effect.fail(body)
		return yield* Schema.decodeUnknownEffect(schema)(body)
	})

/** `GET /api/selfhost/users`. */
export const FetchUsers = Command.define("FetchSelfhostUsers", {
	messages: [Message.CompletedFetchUsers],
	execute: call("GET", "/api/selfhost/users", UsersList).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchUsers({ result })),
	),
})

/** `POST /api/selfhost/users/:sub/{disable,enable,sign-out}`. */
export const RunAction = Command.define("RunSelfhostUserAction", {
	args: { sub: Schema.String, action: Schema.Literals(["disable", "enable", "sign-out"]), label: Schema.String },
	messages: [Message.CompletedAction],
	execute: ({ sub, action, label }) =>
		call("POST", `/api/selfhost/users/${encodeURIComponent(sub)}/${action}`, UserRow).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedAction({ sub, action, label, result })),
		),
})

export const init = (isAdmin: boolean): Return => ({
	model: { isAdmin, users: isAdmin ? AsyncData.Loading() : AsyncData.Idle(), pending: null, notice: null },
	commands: isAdmin ? [FetchUsers()] : [],
})

/** Back on the tab: read again, the list is small and revocations may have happened elsewhere. */
export const revisit = (model: Model): Return =>
	model.isAdmin ? { model: { ...model, notice: null }, commands: [FetchUsers()] } : { model }

const said: Readonly<Record<UserAction, (label: string) => string>> = {
	disable: (label) => `${label} is disabled and signed out everywhere.`,
	enable: (label) => `${label} can sign in again.`,
	"sign-out": (label) => `${label} is signed out everywhere.`,
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchUsers: ({ result }) => ({ model: { ...model, users: AsyncData.settle(model.users, result) } }),
		ClickedRetry: () => ({ model: { ...model, users: AsyncData.Loading() }, commands: [FetchUsers()] }),
		ClickedAction: ({ sub, action, label }) =>
			model.pending !== null
				? { model }
				: { model: { ...model, pending: { sub, action }, notice: null }, commands: [RunAction({ sub, action, label })] },
		CompletedAction: ({ action, label, result }) =>
			Result.match(result, {
				onSuccess: (row) => ({
					model: {
						...model,
						pending: null,
						notice: { tone: "ok" as const, text: said[action](label) },
						users: AsyncData.map(model.users, (list) => ({
							...list,
							users: list.users.map((user) => (user.sub === row.sub ? row : user)),
						})),
					},
				}),
				onFailure: (failure) => ({
					model: { ...model, pending: null, notice: { tone: "error" as const, text: failure.message } },
				}),
			}),
	})
