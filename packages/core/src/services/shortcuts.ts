import { Service, runtime } from "../runtime";
import { RpcService } from "./rpc";
import { DbService } from "./db";
import type { ShortcutBinding } from "../schema";
import { createLogger } from "../shared/log";

const log = createLogger("shortcuts");

/** Filters a shortcut against the active focus-context stack. Composable, e.g. `{ all: ["sidebar"], not: "modal" }`. */
export type When =
  | string
  | string[]
  | {
      all?: string[];
      any?: string[];
      not?: string | string[];
    };

/** Plugin-facing shortcut definition, registered via `register()` from a service's `evaluate()`. */
export interface ShortcutDef {
  /** Stable id, also the DB override key. Convention: `<plugin>.<verb-noun>`. */
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** Single binding or a list of equivalent accelerators. */
  defaultBinding: ShortcutBinding | ShortcutBinding[];
  /** A scoped binding beats an unscoped one for the same key. See {@link When}. */
  when?: When;
  /** Errors are caught and logged so a buggy handler can't break the dispatch loop. */
  handler: () => void | Promise<void>;
}

/** Serializable keystroke event forwarded by the renderer's keydown handler. */
export interface KeyboardInput {
  key: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Settings-UI shape: a def plus its current effective binding and defaults. */
export interface ShortcutListing {
  id: string;
  name: string;
  description?: string;
  category?: string;
  defaultBindings: ShortcutBinding[];
  binding: ShortcutBinding | null;
  isCustom: boolean;
  /** True when the override is `null`, i.e. explicitly disabled. */
  isDisabled: boolean;
  when?: When;
}

/** Snapshot returned by `bindings()`; lets the renderer decide `preventDefault()` locally. */
export interface ShortcutBindingsSnapshot {
  id: string;
  bindings: ShortcutBinding[];
  when?: When;
}

function inputMatchesBinding(
  input: KeyboardInput,
  binding: ShortcutBinding,
): boolean {
  // An unset modifier on the binding means it must be up (keeps Cmd+P distinct from Cmd+Shift+P).
  if (!!binding.meta !== !!input.meta) return false;
  if (!!binding.control !== !!input.control) return false;
  if (!!binding.alt !== !!input.alt) return false;
  if (!!binding.shift !== !!input.shift) return false;
  // `key` matches case-insensitively; `code` (physical key) matches verbatim for layout-independent bindings.
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

/** Test a `when` clause against the active focus-context stack (innermost-first). */
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
 * Specificity score for a `when` clause; higher wins. Unscoped is -1; a match
 * scores higher the closer the matched id is to the focused element. `not`
 * doesn't raise specificity.
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
  let best = 0; // a scoped match with no referenced ids still beats unscoped (-1)
  for (const id of ids) {
    const idx = activeContexts.indexOf(id);
    if (idx === -1) continue;
    const score = activeContexts.length - idx;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Central shortcut registry + dispatcher. Lives under `core` so any plugin can
 * register against it. Overrides live in `db.core.shortcuts` and auto-sync to
 * every renderer.
 */
export class ShortcutsService extends Service.create({
  key: "shortcuts",
  deps: { rpc: RpcService, db: DbService },
}) {
  private defs = new Map<string, ShortcutDef>();

  /** Register a shortcut definition. Returns an unregister function for `this.setup(...)`. */
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

  /** RPC: sorted list of shortcuts plus effective bindings, for the settings UI. */
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

  /** RPC: persist a user override. `binding: null` disables the shortcut. */
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
   * RPC: dispatch a keystroke forwarded by the renderer. `contexts` is the
   * active focus-context stack so dispatch matches what the renderer saw.
   */
  handleKeydown(args: {
    input: KeyboardInput;
    contexts?: readonly string[];
  }): { handled: boolean; id?: string } {
    const overrides = (this.ctx.db.client.readRoot().core?.shortcuts ?? {}) as Record<
      string,
      ShortcutBinding | null
    >;
    const active =
      args.contexts ??
      ((this.ctx.db.client.readRoot().core?.focus?.contexts ?? []) as string[]);

    // Pick the most-specific def whose binding matches and whose `when` is satisfied.
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
      // Ties fall to first-registered.
    }

    if (best) {
      this.invoke(best.def);
      return { handled: true, id: best.def.id };
    }
    return { handled: false };
  }

  /** RPC: publish the active focus-context stack to `root.core.focus.contexts` for other subscribers. */
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

  /** Read the active focus-context stack (innermost first) from the replica. */
  activeContexts(): string[] {
    return (
      (this.ctx.db.client.readRoot().core?.focus?.contexts ?? []) as string[]
    ).slice();
  }

  /** RPC: snapshot of active bindings (with `when`) for the renderer's local matcher. */
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
    // No work at boot; plugins register during their own `evaluate()`.
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
      // RPC may not be initialised during very-early registrations; the next emit catches up.
    }
  }
}

runtime.register(ShortcutsService, import.meta);
