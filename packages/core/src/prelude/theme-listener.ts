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
export function installThemeListener(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data;
    if (!data || data.kind !== "zenbu:view-theme") return;
    const tokens: Record<string, string> = data.tokens ?? {};
    const css =
      ":root{" +
      Object.keys(tokens)
        .map((k) => `${k}:${tokens[k]}`)
        .join(";") +
      "}";
    let el = document.getElementById(
      "zenbu-view-theme",
    ) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "zenbu-view-theme";
      document.head.prepend(el);
    }
    el.textContent = css;
  });
}
