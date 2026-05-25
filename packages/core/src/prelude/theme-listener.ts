/**
 * Theme listener installed into every Zenbu view's iframe by the advice
 * prelude. The host posts `{ kind: "zenbu:view-theme", tokens }` whenever
 * the user changes themes; we materialize those tokens as CSS custom
 * properties on `:root` so the iframe re-paints with the new theme
 * without a reload.
 *
 * The very first paint's theme is handled separately by an inlined
 * `<style id="zenbu-view-theme">` tag injected at HTML-transform time
 * (see `buildInlineThemeCss` in `vite-plugins.ts`). This listener takes
 * over from there and keeps that same `<style>` element in sync with
 * later updates.
 */
const CSS_CUSTOM_PROPERTY_RE = /^--[a-zA-Z0-9_-]+$/;
const VIEW_BACKGROUND_TOKEN = "--zenbu-view-background";
const VIEW_FOREGROUND_TOKEN = "--zenbu-view-foreground";
const VIEW_COLOR_SCHEME_TOKEN = "--zenbu-view-color-scheme";

function isSafeCssValue(value: string): boolean {
  return !/[;{}<>]/.test(value);
}

function sanitizeTokens(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const tokens: Record<string, string> = {};
  for (const [key, tokenValue] of Object.entries(value)) {
    if (!CSS_CUSTOM_PROPERTY_RE.test(key)) continue;
    if (typeof tokenValue !== "string") continue;
    if (!isSafeCssValue(tokenValue)) continue;
    tokens[key] = tokenValue;
  }
  return tokens;
}

function buildThemeCss(tokens: Record<string, string>): string {
  const root =
    ":root:root{" +
    Object.keys(tokens)
      .map((k) => `${k}:${tokens[k]}`)
      .join(";") +
    "}";
  const background = `var(${VIEW_BACKGROUND_TOKEN}, var(--background, Canvas))`;
  const foreground = `var(${VIEW_FOREGROUND_TOKEN}, var(--foreground, CanvasText))`;
  const colorScheme = `var(${VIEW_COLOR_SCHEME_TOKEN}, normal)`;
  return (
    root +
    `html,body{background:${background};color:${foreground};color-scheme:${colorScheme}}` +
    "body{margin:0}" +
    `#root{background:${background};color:${foreground}}`
  );
}

export function installThemeListener(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || data.kind !== "zenbu:view-theme") return;
    const tokens = sanitizeTokens((data as { tokens?: unknown }).tokens);
    let el = document.getElementById(
      "zenbu-view-theme",
    ) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "zenbu-view-theme";
      document.head.prepend(el);
    }
    el.textContent = buildThemeCss(tokens);
  });
}
