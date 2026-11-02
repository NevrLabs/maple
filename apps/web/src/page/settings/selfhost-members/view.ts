import { initialsFrom } from "@maple/ui/lib/initials"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "../../../ui/avatar-tone"
import { button } from "../../../ui/button"
import { avatarFallback } from "../../../ui/display"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { adminOnlyNote, sectionNote, settingsSection, settingsSections } from "../kit/section"
import { Message, type Model, type UserAction, type UserRow } from "./model"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number }>

const COLUMN = { role: "w-24", seen: "w-32", idp: "w-44", actions: "w-56" } as const

export const description = "People who signed in through your identity provider. Roles are managed in your identity provider."

const labelOf = (user: UserRow): string => user.name ?? user.email ?? user.sub

const hostOf = (url: string | null): string => {
	if (url === null) return "—"
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

const roleBadge = (h: H, user: UserRow): Html =>
	h.span(
		[
			h.DataAttribute("user-role", user.role),
			h.Class(
				cn(
					"inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-2xs",
					user.role === "admin" ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
				),
			),
		],
		[user.role],
	)

const statusBadge = (h: H, user: UserRow): ReadonlyArray<Html> =>
	user.disabled
		? [
				h.span(
					[h.DataAttribute("user-disabled", ""), h.Class("ml-2 shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-2xs text-destructive")],
					["Disabled"],
				),
			]
		: []

const actionButton = (h: H, model: Model, user: UserRow, action: UserAction, text: string, isDestructive = false): Html =>
	button(
		h,
		{
			size: "xs",
			variant: isDestructive ? "destructive" : "outline",
			isLoading: model.pending?.sub === user.sub && model.pending.action === action,
			isDisabled: model.pending !== null,
			attributes: [
				h.DataAttribute("user-action", action),
				h.OnClick(Message.ClickedAction({ sub: user.sub, action, label: labelOf(user) })),
			],
		},
		[text],
	)

const actionsCell = (h: H, model: Model, user: UserRow, you: string): Html => {
	if (user.isBreakGlass) return tableCell(h, [h.span([h.Class("text-2xs text-muted-foreground")], ["Break-glass · always on"])], "text-right")
	if (user.sub === you) return tableCell(h, [h.span([h.Class("text-2xs text-muted-foreground")], ["You"])], "text-right")
	return tableCell(
		h,
		[
			h.div(
				[h.Class("flex justify-end gap-1.5")],
				user.disabled
					? [actionButton(h, model, user, "enable", "Enable")]
					: [actionButton(h, model, user, "sign-out", "Sign out everywhere"), actionButton(h, model, user, "disable", "Disable", true)],
			),
		],
		"text-right",
	)
}

const userRow = (h: H, model: Model, user: UserRow, you: string, nowMs: number): Html =>
	tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 items-center gap-3")],
					[
						avatarFallback(
							h,
							{ className: "size-6 shrink-0", fallbackClassName: `font-medium ${warmAvatarTone(labelOf(user))}` },
							user.isBreakGlass ? "RT" : initialsFrom(labelOf(user)),
						),
						h.div(
							[h.Class("min-w-0")],
							[
								h.div([h.Class("flex min-w-0 items-center text-xs font-medium")], [truncatedText(h, { text: labelOf(user) }), ...statusBadge(h, user)]),
								truncatedText(h, { text: user.isBreakGlass ? "root password" : (user.email ?? user.sub), className: "text-xs text-muted-foreground" }),
							],
						),
					],
				),
			]),
			tableCell(h, [roleBadge(h, user)], COLUMN.role),
			tableCell(
				h,
				[
					user.lastSeen === null
						? "—"
						: h.span([h.Title(new Date(user.lastSeen).toLocaleString())], [formatRelativeTime(Date.parse(user.lastSeen), nowMs)]),
				],
				cn(COLUMN.seen, "text-xs text-muted-foreground"),
			),
			tableCell(h, [user.isBreakGlass ? "Maple" : hostOf(user.idp)], cn(COLUMN.idp, "truncate font-mono text-2xs text-muted-foreground")),
			...(model.isAdmin ? [actionsCell(h, model, user, you)] : []),
		],
		cn(user.disabled && "opacity-70"),
		[h.DataAttribute("user-row", user.sub)],
	)

const skeletonRows = (h: H): ReadonlyArray<Html> =>
	[0, 1, 2].map((index) =>
		tableRow(h, [
			tableCell(h, [skeleton(h, "h-4 w-48")]),
			tableCell(h, [skeleton(h, "h-4 w-12")]),
			tableCell(h, [skeleton(h, "h-3 w-16")]),
			tableCell(h, [skeleton(h, "h-3 w-28")]),
			tableCell(h, [skeleton(h, "ml-auto h-6 w-40")]),
		], undefined, [h.Key(`skeleton-${index}`)]),
	)

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => {
	if (!model.isAdmin)
		return settingsSections(h, [adminOnlyNote(h, ["Only admins can see and manage Maple users. Roles are managed in your identity provider."])])
	const list = AsyncData.getOrElse(model.users, () => null)
	const failure = AsyncData.isFailure(model.users) ? model.users.error : null
	return settingsSections(h, [
		settingsSection(h, { id: "settings-selfhost-members", title: "Members", isLead: true, padded: false }, [
			table(h, { className: "table-fixed" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Member"]),
						tableHead(h, ["Role"], COLUMN.role),
						tableHead(h, ["Last seen"], COLUMN.seen),
						tableHead(h, ["Identity provider"], COLUMN.idp),
						tableHead(h, [h.span([h.Class("sr-only")], ["Actions"])], COLUMN.actions),
					]),
				]),
				tableBody(h, [
					...(list === null && failure === null ? skeletonRows(h) : []),
					...(list?.users ?? []).map((user) => userRow(h, model, user, list?.you ?? "", inputs.nowMs)),
				]),
			]),
			...(failure === null
				? []
				: [
						h.div(
							[h.Class("flex items-center justify-between gap-3 px-4 py-3")],
							[sectionNote(h, failure.message), button(h, { size: "xs", variant: "outline", attributes: [h.OnClick(Message.ClickedRetry())] }, ["Retry"])],
						),
					]),
			...(model.notice === null
				? []
				: [
						h.p(
							[
								h.Role("status"),
								h.DataAttribute("users-notice", model.notice.tone),
								h.Class(cn("px-4 py-2 text-xs", model.notice.tone === "ok" ? "text-muted-foreground" : "text-destructive")),
							],
							[model.notice.text],
						),
					]),
		]),
		adminOnlyNote(h, [
			"Roles are managed in your identity provider: grant maple-admin or maple-viewer there. Disable stops a person at once (and on their next sign-in); Sign out everywhere ends their current sessions only.",
		]),
	])
})
