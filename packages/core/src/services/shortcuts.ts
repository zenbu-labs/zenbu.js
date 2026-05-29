import { Service, runtime } from "../runtime";
import { RpcService } from "./rpc";
import { DbService } from "./db";
import type { ShortcutBinding } from "../schema";
import { createLogger } from "../shared/log";

const log = createLogger("shortcuts");

/**
 * `when` clause for a shortcut. Filters the shortcut against the
 * currently-active focus context stack (see `FocusContext` in
 * `@zenbujs/core/react`).
 *
 *   undefined         → always active (current behavior)
 *   "sidebar"         → "sidebar" must be in the active stack
 *   ["a", "b"]        → both "a" AND "b" must be active
 *   { any: ["a","b"]} → at least one of the listed ids must be active
 *   { all: [...] }    → every listed id must be active
 *   { not: "modal" }  → "modal" must NOT be active
 *
 * Composable: `{ all: ["sidebar"], not: "modal" }`.
 */
export type When =
  | string
  | string[]
  | {
      all?: string[];
      any?: string[];
      not?: string | string[];
    };

/**
 * Plugin-facing shortcut definition. Plugins call
 * `runtime.get(ShortcutsService).register({...})` (or grab the service via
 * deps) from inside `evaluate()` to declare what shortcuts exist; the
 * service stores the def in memory and persists only user overrides.
 *
 * `handler` is a fire-and-forget callback that runs in the main process
 * when the shortcut fires. The typical implementation is
 *   `() => this.ctx.rpc.emit.<plugin>.<event>({ source })`
 * so existing renderer subscriptions keep working.
 *
 * `when` (optional) restricts the shortcut to a focus context. Without
 * a `when`, the binding is global. With one, it only fires while the
 * named context is in the active stack — and a scoped binding always
 * beats an unscoped one for the same key, so global `Space` can
 * coexist with a sidebar-scoped `Space`.
 */
export interface ShortcutDef {
  /**
   * Stable id used in the DB as the override key and in the settings UI
   * as the canonical pointer. Convention: `<plugin>.<verb-noun>` (e.g.
   * `app.toggleCommandPalette`).
   */
  id: string;
  /** Human label shown in the settings UI. */
  name: string;
  description?: string;
  /** Optional UI category for grouping (e.g. "Navigation", "Panels"). */
  category?: string;
  /**
   * The factory default. Single binding or a list of equivalent
   * accelerators (e.g. Cmd+/ and Cmd+\\ both opening the same split).
   */
  defaultBinding: ShortcutBinding | ShortcutBinding[];
  /** Optional focus-context filter. See {@link When}. */
  when?: When;
  /**
   * Called when the resolved binding matches a keystroke. Errors are
   * caught and logged so a buggy handler can't take down the dispatch
   * loop.
   */
  handler: () => void | Promise<void>;
}

/**
 * Wire-friendly shape of one keystroke event, sent up by the prelude's
 * keydown forwarder. Matches `KeyboardEvent` plus the modifier flags we
 * actually care about. Stays a plain object so it serializes through
 * postMessage and RPC.
 */
export interface KeyboardInput {
  key: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * Settings-UI shape. Combines a registered definition with the current
 * effective binding (override if present, otherwise default[0]) and the
 * full list of defaults so the UI can render the reset button correctly.
 */
export interface ShortcutListing {
  id: string;
  name: string;
  description?: string;
  category?: string;
  defaultBindings: ShortcutBinding[];
  binding: ShortcutBinding | null;
  /** True if a row has a user-set override in the DB. */
  isCustom: boolean;
  /** True when the override is `null`, i.e. explicitly disabled. */
  isDisabled: boolean;
  /** The `when` clause attached to the def, if any. */
  when?: When;
}

/**
 * Snapshot returned by `bindings()`. The prelude uses this to decide
 * whether to `preventDefault()` a keystroke synchronously. `when` is
 * passed through so the prelude can do the same filtering locally.
 */
export interface ShortcutBindingsSnapshot {
  id: string;
  bindings: ShortcutBinding[];
  when?: When;
}

function inputMatchesBinding(
  input: KeyboardInput,
  binding: ShortcutBinding,
): boolean {
  // Modifier comparison treats `undefined` on the binding side as "must be
  // false" — a binding that doesn't mention shift requires shift to be
  // *up*. This keeps Cmd+P distinct from Cmd+Shift+P.
  if (!!binding.meta !== !!input.meta) return false;
  if (!!binding.control !== !!input.control) return false;
  if (!!binding.alt !== !!input.alt) return false;
  if (!!binding.shift !== !!input.shift) return false;
  // `key` is the post-layout character. We match case-insensitively so
  // Shift+P and Shift+p both work. `code` is the physical key code (e.g.
  // `KeyP`, `BracketLeft`) — matched verbatim when the binding specifies
  // it, so e.g. bracket shortcuts still work on keyboard layouts where
  // the typed character differs.
  if (binding.code && input.code !== binding.code) return false;
  if (binding.key) {
    const want = binding.key.toLowerCase();
    const have = (input.key ?? "").toLowerCase();
    if (have !== want) return false;
  }
  return true;
}

function effectiveBindings(
  def: ShortcutDef,
  override: ShortcutBinding | null | undefined,
): ShortcutBinding[] {
  if (override === null) return []; // explicitly disabled
  if (override !== undefined) return [override];
  return Array.isArray(def.defaultBinding)
    ? def.defaultBinding
    : [def.defaultBinding];
}

/**
 * Test a `when` clause against the active focus-context stack.
 *
 * The active stack is innermost-first: index 0 is the most-nested
 * `<FocusContext>` ancestor of the focused element, and the last
 * entry is the outermost.
 */
export function whenMatches(
  when: When | undefined,
  activeContexts: readonly string[],
): boolean {
  if (when === undefined) return true;
  const set = new Set(activeContexts);
  if (typeof when === "string") return set.has(when);
  if (Array.isArray(when)) return when.every((id) => set.has(id));
  if (when.all && !when.all.every((id) => set.has(id))) return false;
  if (when.any && !when.any.some((id) => set.has(id))) return false;
  if (when.not !== undefined) {
    const list = Array.isArray(when.not) ? when.not : [when.not];
    if (list.some((id) => set.has(id))) return false;
  }
  return true;
}

/**
 * Compute a numeric specificity score for a `when` clause against the
 * active stack. Higher = wins.
 *
 *   undefined  → -1   (unscoped: loses to any scoped match for same key)
 *   matched    →  N   where N is `activeContexts.length - innermostIndex`,
 *                     i.e. the closer the matched id is to the focused
 *                     element, the higher the score.
 *
 * Only positive (matching) ids referenced in `all` / `any` / direct
 * string / array contribute. `not` is satisfied but doesn't raise
 * specificity (you can't "win" by virtue of *not* being inside a
 * context).
 */
export function whenSpecificity(
  when: When | undefined,
  activeContexts: readonly string[],
): number {
  if (when === undefined) return -1;
  const ids: string[] = [];
  if (typeof when === "string") ids.push(when);
  else if (Array.isArray(when)) ids.push(...when);
  else {
    if (when.all) ids.push(...when.all);
    if (when.any) ids.push(...when.any);
  }
  let best = 0; // a scoped match with no referenced ids still > unscoped (-1)
  for (const id of ids) {
    const idx = activeContexts.indexOf(id);
    if (idx === -1) continue;
    // innermost (idx 0) gets the highest score.
    const score = activeContexts.length - idx;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Central shortcut registry + dispatcher. Lives under `core` so any
 * plugin can register against it without depending on the host app.
 *
 * Lifecycle:
 *   1. Plugin services call `register({...})` from `evaluate()`
 *      (wrapped in `this.setup` so re-evaluates de-dup cleanly).
 *   2. Each renderer's `ZenbuProvider` mounts a `ShortcutDispatcher`
 *      that captures `keydown` on `window`, reads the active focus
 *      context stack from the DOM, and calls `handleKeydown` over
 *      RPC for dispatch.
 *   3. `handleKeydown` filters defs by their `when` clause against
 *      the active stack, picks the most-specific match, and runs
 *      its handler.
 *
 * Bindings live in `db.core.shortcuts`. The replica auto-syncs them
 * to every renderer so the settings UI and the renderer's
 * `preventDefault` cache stay consistent without manual broadcasts.
 */
export class ShortcutsService extends Service.create({
  key: "shortcuts",
  deps: { rpc: RpcService, db: DbService },
}) {
  private defs = new Map<string, ShortcutDef>();

  /**
   * Register a shortcut definition. Returns an unregister function so
   * callers can wrap the call in `this.setup(...)` and get clean teardown
   * on hot reload.
   */
  register(def: ShortcutDef): () => void {
    if (this.defs.has(def.id)) {
      log.verbose(`re-registering "${def.id}"`);
    }
    this.defs.set(def.id, def);
    this.notifyChanged();
    return () => {
      if (this.defs.get(def.id) === def) {
        this.defs.delete(def.id);
        this.notifyChanged();
      }
    };
  }

  /**
   * RPC: return the full sorted list of shortcuts plus their current
   * effective bindings. Used by the settings UI.
   */
  list(): ShortcutListing[] {
    const overrides = (this.ctx.db.client.readRoot().core?.shortcuts ?? {}) as Record<
      string,
      ShortcutBinding | null
    >;
    const rows: ShortcutListing[] = [];
    for (const def of this.defs.values()) {
      const hasOverride = Object.prototype.hasOwnProperty.call(
        overrides,
        def.id,
      );
      const override = hasOverride ? overrides[def.id] : undefined;
      const bindings = effectiveBindings(def, override);
      rows.push({
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        defaultBindings: Array.isArray(def.defaultBinding)
          ? def.defaultBinding
          : [def.defaultBinding],
        binding: bindings[0] ?? null,
        isCustom: hasOverride,
        isDisabled: hasOverride && override === null,
        when: def.when,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  /**
   * RPC: persist a user override. Pass `binding: null` to explicitly
   * disable the shortcut, or call `resetBinding` to revert to default.
   */
  async setBinding(args: {
    id: string;
    binding: ShortcutBinding | null;
  }): Promise<void> {
    await this.ctx.db.client.update((root) => {
      const section = (root as any).core;
      if (!section.shortcuts) section.shortcuts = {};
      section.shortcuts[args.id] = args.binding;
    });
    this.notifyChanged();
  }

  /** RPC: drop the override row so the default takes effect again. */
  async resetBinding(args: { id: string }): Promise<void> {
    await this.ctx.db.client.update((root) => {
      const section = (root as any).core;
      if (!section.shortcuts) return;
      delete section.shortcuts[args.id];
    });
    this.notifyChanged();
  }

  /**
   * RPC: dispatch a keystroke forwarded by the renderer's
   * `ShortcutDispatcher`. The caller passes the active focus-context
   * stack (innermost first) so dispatch sees the same context the
   * renderer used to decide `preventDefault()`.
   *
   * Returns `{ handled, id? }`. Fire-and-forget at the renderer side
   * — the result is only used for debug logging.
   */
  handleKeydown(args: {
    input: KeyboardInput;
    /**
     * Live active focus-context stack (innermost first) at the
     * moment the keystroke fired.
     */
    contexts?: readonly string[];
  }): { handled: boolean; id?: string } {
    const overrides = (this.ctx.db.client.readRoot().core?.shortcuts ?? {}) as Record<
      string,
      ShortcutBinding | null
    >;
    const active =
      args.contexts ??
      ((this.ctx.db.client.readRoot().core?.focus?.contexts ?? []) as string[]);

    // Collect all (def, binding) candidates that match the keystroke
    // *and* whose `when` is satisfied by the current active stack.
    type Cand = { def: ShortcutDef; score: number };
    let best: Cand | null = null;
    for (const def of this.defs.values()) {
      const override = Object.prototype.hasOwnProperty.call(overrides, def.id)
        ? overrides[def.id]
        : undefined;
      const bindings = effectiveBindings(def, override);
      let matchedAny = false;
      for (const b of bindings) {
        if (inputMatchesBinding(args.input, b)) {
          matchedAny = true;
          break;
        }
      }
      if (!matchedAny) continue;
      if (!whenMatches(def.when, active)) continue;
      const score = whenSpecificity(def.when, active);
      if (best === null || score > best.score) {
        best = { def, score };
      }
      // Ties fall to first-registered (deterministic; preserves the
      // existing single-match behavior for un-scoped shortcuts).
    }

    if (best) {
      this.invoke(best.def);
      return { handled: true, id: best.def.id };
    }
    return { handled: false };
  }

  /**
   * RPC: write the flattened focus-context stack to the DB. Plugin
   * services that want to read "which context is active right now"
   * via `useDb` can subscribe to `root.core.focus.contexts`.
   *
   * The renderer's `ShortcutDispatcher` doesn't need this round-trip
   * for its own dispatch — it reads the active stack from the DOM
   * synchronously at keydown time — but writing it lets other
   * subscribers observe focus changes.
   */
  setFocus(args: { contexts: string[] }): void {
    void this.ctx.db.client
      .update((root) => {
        const r = root as any;
        if (!r.core.focus) {
          r.core.focus = { contexts: [] };
        }
        r.core.focus.contexts = args.contexts ?? [];
      })
      .catch(() => {});
  }

  /**
   * Read the current active focus-context stack (innermost first) from
   * the replica. Synchronous; safe to call from any service.
   */
  activeContexts(): string[] {
    return (
      (this.ctx.db.client.readRoot().core?.focus?.contexts ?? []) as string[]
    ).slice();
  }

  /**
   * RPC: snapshot of the active bindings, in the simple shape the
   * renderer's `ShortcutDispatcher` uses for its local matcher. The
   * `when` clause is included so the renderer can replicate the
   * filtering logic and only `preventDefault()` when the binding
   * would actually fire.
   */
  bindings(): ShortcutBindingsSnapshot[] {
    const overrides = (this.ctx.db.client.readRoot().core?.shortcuts ?? {}) as Record<
      string,
      ShortcutBinding | null
    >;
    const out: ShortcutBindingsSnapshot[] = [];
    for (const def of this.defs.values()) {
      const override = Object.prototype.hasOwnProperty.call(overrides, def.id)
        ? overrides[def.id]
        : undefined;
      const bindings = effectiveBindings(def, override);
      if (bindings.length > 0) {
        out.push({ id: def.id, bindings, when: def.when });
      }
    }
    return out;
  }

  evaluate() {
    // No work at boot. Plugins register via `register()` during their
    // own `evaluate()`.
  }

  private invoke(def: ShortcutDef): void {
    try {
      const result = def.handler();
      if (result && typeof (result as any).then === "function") {
        (result as Promise<void>).catch((e) =>
          log.verbose(`shortcut "${def.id}" handler rejected: ${String(e)}`),
        );
      }
    } catch (e) {
      log.verbose(`shortcut "${def.id}" handler threw: ${String(e)}`);
    }
  }

  private notifyChanged(): void {
    try {
      this.ctx.rpc.emit.core.shortcuts.changed({});
    } catch {
      // RPC may not be initialised yet during very-early registrations
      // (e.g. during the first evaluate pass). The next emit catches up.
    }
  }
}

runtime.register(ShortcutsService, import.meta);
