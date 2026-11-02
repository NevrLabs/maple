/**
 * NevrLabs selfhost (PATCHES #5): who the self-hosted session belongs to, read from the session token itself.
 *
 * The token is the one the API verifies on every request; these display claims (`name`, `email`, `roles`) are read
 * here only to label the UI and hide controls a viewer cannot use — the server gate is what enforces the role.
 * Root (break-glass) tokens carry no name: they read as "Root", admin.
 */
import { readSessionTokenSync } from "./auth-api"

export type SessionRole = "admin" | "viewer"
export type SelfhostIdentity = Readonly<{ sub: string; name: string; email: string | null; role: SessionRole; isBreakGlass: boolean }>

const ROOT: SelfhostIdentity = { sub: "root", name: "Root", email: null, role: "admin", isBreakGlass: true }

const decode = (segment: string): Record<string, unknown> | null => {
	try {
		const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
		const json = decodeURIComponent(
			Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
		)
		const value: unknown = JSON.parse(json)
		return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/** The identity in a session token; root for a token without one (or one that cannot be read). */
export const identityOfToken = (token: string | null): SelfhostIdentity => {
	const payload = token?.split(".")[1]
	const claims = payload === undefined ? null : decode(payload)
	if (claims === null || typeof claims.sub !== "string") return ROOT
	const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : []
	const isAdmin = roles.length === 0 || roles.includes("root") || roles.includes("org:admin")
	const email = typeof claims.email === "string" && claims.email !== "" ? claims.email : null
	const name = typeof claims.name === "string" && claims.name !== "" ? claims.name : (email ?? (claims.sub === "root" ? "Root" : claims.sub))
	return { sub: claims.sub, name, email, role: isAdmin ? "admin" : "viewer", isBreakGlass: !claims.sub.startsWith("oidc:") }
}

/** The signed-in identity of this tab (self-hosted mode). */
export const selfhostIdentity = (): SelfhostIdentity => identityOfToken(readSessionTokenSync())

/** A viewer session: hide create/edit controls (the server refuses them anyway). */
export const isViewerSession = (): boolean => selfhostIdentity().role === "viewer"
