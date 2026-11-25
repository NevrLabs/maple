import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { inlineLogo, LOGO_MAX_BYTES, NO_LOGO } from "./og-logo"
import { makeOgRenderer, type OgRender } from "./og-render"
import { type StatusEnv, StatusOgImageError } from "./ports"

// The selfhost bundle copies these fonts beside status.js; the Worker uses Data modules instead.
const fonts = async (font: string) => {
	const read = (subset: string) => readFile(new URL(`./og-fonts/${font}-${subset}.ttf`, import.meta.url))
	const [latin, latinExt, cyrillic] = await Promise.all([
		read("latin"),
		read("latin-ext"),
		read("cyrillic"),
	])
	return { latin, "latin-ext": latinExt, cyrillic }
}

let renderer: Promise<OgRender> | undefined
const startRenderer = async () => {
	const [sans, serif, mono] = await Promise.all([fonts("sans"), fonts("serif"), fonts("mono")])
	return makeOgRenderer(
		async () => {
			await import("@takumi-rs/wasm/auto") // Bun entry point initializes the shared WASM module.
		},
		{ sans, serif, mono },
	)
}

// ponytail: no server-side PNG cache; add a bounded cache keyed by card version if preview traffic warrants it.
export const bunOgImage: StatusEnv["ogImage"] = (_key, card) =>
	Effect.tryPromise({
		try: async () => {
			const draw = await (renderer ??= startRenderer().catch((error) => {
				renderer = undefined
				throw error
			}))
			// Never fetch remote logo URLs from the selfhost network. Render the page name instead.
			const logo =
				card.logoUrl?.startsWith("data:") &&
				card.logoUrl.length <= 4 * Math.ceil(LOGO_MAX_BYTES / 3) + 64
					? inlineLogo(card.logoUrl)
					: NO_LOGO
			if (logo._tag === "none") return { png: await draw(card, NO_LOGO), complete: true }
			try {
				return { png: await draw(card, logo), complete: true }
			} catch {
				return { png: await draw(card, NO_LOGO), complete: false }
			}
		},
		catch: (cause) => new StatusOgImageError({ message: "Rendering the selfhost preview failed", cause }),
	})
