import { envUrl } from "./env-url"

/**
 * selfhost (PATCHES.md #2): a path-only value (`/_api`) resolves against the page's origin at
 * runtime, so one web image serves every hostname behind a same-origin proxy.
 */
const sameOrigin = (url: string): string =>
	url.startsWith("/") && typeof globalThis.location !== "undefined" ? `${globalThis.location.origin}${url}` : url


/**
 * Origin of the standalone ElectricSQL shape-proxy worker (`apps/electric-sync`).
 * Set at build time via `VITE_ELECTRIC_SYNC_URL`; defaults to the local worker's
 * dev port (see `apps/electric-sync/package.json` `dev:app`).
 */
const configuredElectricSyncUrl = envUrl(import.meta.env.VITE_ELECTRIC_SYNC_URL)

export const electricSyncBaseUrl =
	configuredElectricSyncUrl === undefined ? "http://127.0.0.1:3476" : sameOrigin(configuredElectricSyncUrl)

/** Off on a deploy with no Electric upstream (`VITE_ELECTRIC_SYNC_DISABLED=1`, `preview:web`). */
export const electricSyncEnabled = import.meta.env.VITE_ELECTRIC_SYNC_DISABLED !== "1"
