import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"

// NevrLabs selfhost (PATCHES #5): Settings > Members on a self-hosted deployment — the people who signed in
// through the OIDC provider (`selfhost_users`), read and revoked through /api/selfhost/users. No invites: the
// identity provider owns who exists and which role they hold.

export const UserRow = Schema.Struct({
	sub: Schema.String,
	email: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	idp: Schema.NullOr(Schema.String),
	role: Schema.Literals(["admin", "viewer"]),
	firstSeen: Schema.NullOr(Schema.String),
	lastSeen: Schema.NullOr(Schema.String),
	disabled: Schema.Boolean,
	sessionsValidAfter: Schema.NullOr(Schema.String),
	isBreakGlass: Schema.Boolean,
})
export type UserRow = typeof UserRow.Type

export const UsersList = Schema.Struct({ users: Schema.Array(UserRow), you: Schema.String })
export type UsersList = typeof UsersList.Type

export const UsersData = AsyncData.Schema(UsersList, LoadFailure)

export const UserAction = Schema.Literals(["disable", "enable", "sign-out"])
export type UserAction = typeof UserAction.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	users: UsersData.schema,
	/** The row a write is in flight for, and which write. */
	pending: Schema.NullOr(Schema.Struct({ sub: Schema.String, action: UserAction })),
	/** The last write's outcome, said under the table. */
	notice: Schema.NullOr(Schema.Struct({ tone: Schema.Literals(["ok", "error"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchUsers: { result: Schema.Result(UsersList, LoadFailure) },
	ClickedRetry: {},
	ClickedAction: { sub: Schema.String, action: UserAction, label: Schema.String },
	CompletedAction: { sub: Schema.String, action: UserAction, label: Schema.String, result: Schema.Result(UserRow, LoadFailure) },
})
export type Message = typeof Message.Type
