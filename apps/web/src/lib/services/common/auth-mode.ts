const authMode = import.meta.env.VITE_MAPLE_AUTH_MODE?.trim().toLowerCase()

const mapleAuthMode = authMode === "clerk" ? "clerk" : "self_hosted"
export const isClerkAuthEnabled = mapleAuthMode === "clerk"

/** NevrLabs selfhost: `VITE_MAPLE_OIDC=zitadel` adds "Sign in with Zitadel" to the root-password page. */
export const oidcProvider: "zitadel" | null =
	!isClerkAuthEnabled && import.meta.env.VITE_MAPLE_OIDC?.trim().toLowerCase() === "zitadel" ? "zitadel" : null
