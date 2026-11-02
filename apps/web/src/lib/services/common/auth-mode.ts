const authMode = import.meta.env.VITE_MAPLE_AUTH_MODE?.trim().toLowerCase()

const mapleAuthMode = authMode === "clerk" ? "clerk" : "self_hosted"
export const isClerkAuthEnabled = mapleAuthMode === "clerk"

/**
 * NevrLabs selfhost: `VITE_MAPLE_OIDC=<provider label>` adds "Sign in with <label>" to the root-password page, for
 * any OIDC provider (`Zitadel`, `Authentik`, `Noovoleum SSO`). `zitadel` (the first release's value) reads `Zitadel`.
 */
const oidcLabel = import.meta.env.VITE_MAPLE_OIDC?.trim() ?? ""
export const oidcProvider: string | null =
	isClerkAuthEnabled || oidcLabel === "" || oidcLabel.toLowerCase() === "off"
		? null
		: oidcLabel.toLowerCase() === "zitadel"
			? "Zitadel"
			: oidcLabel
