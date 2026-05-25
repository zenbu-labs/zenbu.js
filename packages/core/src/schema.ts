import zod from "zod";
import { createSchema, f, type InferSchemaRoot } from "@zenbu/kyju/schema";

/**
 * One row in `core.registrations`: a typed reference to a source
 * module the renderer should dynamically import and apply.
 *
 * Discriminated by `kind`. Common fields live on every row; kind-
 * specific fields hang off the variant. The renderer-side reconciler
 * watches this list, diffs against locally-applied state, and runs
 * kind-specific apply / cleanup on each change.
 *
 * `rev` is a monotonic counter the framework bumps when the source
 * file changes (Vite HMR path). It serves as the cache-buster on the
 * dynamic-import URL (`${modulePath}?rev=${rev}`).
 *
 * `pluginName` records the owning plugin so the framework can prune
 * stale rows that persist across restarts from plugins that are no
 * longer loaded.
 */
const registrationBase = {
  modulePath: zod.string(),
  exportName: zod.string().default("default"),
  rev: zod.number().default(0),
  pluginName: zod.string().optional(),
  meta: zod.record(zod.string(), zod.unknown()).optional(),
};

const functionRegistrationSchema = zod.object({
  kind: zod.literal("function"),
  name: zod.string(),
  ...registrationBase,
});

const componentViewRegistrationSchema = zod.object({
  kind: zod.literal("componentView"),
  type: zod.string(),
  ...registrationBase,
});

const adviceRegistrationSchema = zod.object({
  kind: zod.literal("advice"),
  view: zod.string(),
  moduleId: zod.string(),
  name: zod.string(),
  adviceType: zod.enum(["before", "after", "around", "replace"]),
  ...registrationBase,
});

const contentScriptRegistrationSchema = zod.object({
  kind: zod.literal("contentScript"),
  view: zod.string(),
  ...registrationBase,
});

const registrationSchema = zod.discriminatedUnion("kind", [
  functionRegistrationSchema,
  componentViewRegistrationSchema,
  adviceRegistrationSchema,
  contentScriptRegistrationSchema,
]);

const viewRegistryEntrySchema = zod.object({
  type: zod.string(),
  url: zod.string(),
  port: zod.number(),
  icon: zod.string().optional(),
  /**
   * How the renderer should mount this view. Defaults to `"iframe"` when
   * omitted (existing behavior). `"component"` means the host renders a
   * React component registered client-side under `type` — no Vite
   * server, no iframe, args flow as a prop.
   */
  rendering: zod.enum(["iframe", "component"]).optional(),
  /**
   * Open by design — see `ViewMeta` in
   * `services/view-registry.ts`. The framework only attaches
   * meaning to a handful of well-known fields; everything else is
   * userland metadata that round-trips through `passthrough()`.
   */
  meta: zod
    .object({
      kind: zod.string().optional(),
      sidebar: zod.boolean().optional(),
      bottomPanel: zod.boolean().optional(),
      label: zod.string().optional(),
    })
    .passthrough()
    .optional(),
});

const windowBoundsSchema = zod.object({
  x: zod.number(),
  y: zod.number(),
  width: zod.number(),
  height: zod.number(),
});

const windowPrefsSchema = zod.object({
  lastKnownBounds: windowBoundsSchema.optional(),
});

/**
 * One keystroke pattern, matched against `KeyboardEvent`-ish input by the
 * shortcut service. Mirrors the shape produced by the prelude's keydown
 * forwarder so the renderer doesn't have to translate.
 */
const shortcutBindingSchema = zod.object({
  key: zod.string().optional(),
  code: zod.string().optional(),
  meta: zod.boolean().optional(),
  control: zod.boolean().optional(),
  alt: zod.boolean().optional(),
  shift: zod.boolean().optional(),
});

/**
 * One entry in a focused-view chain. The chain starts at the entrypoint
 * (outermost) and ends at whichever iframe currently owns focus.
 */
const viewChainEntrySchema = zod.object({
  viewType: zod.string(),
  source: zod.string().optional(),
});

/**
 * Live focus state for the current window, written by the renderer
 * bridge and consumed by `ShortcutsService`'s dispatch + filtering.
 *
 * `iframes` is the iframe-level focus chain (outermost → innermost),
 * mirroring the legacy `focusedView.chain`. `contexts` is the *flat,
 * innermost-first* stack of `<FocusContext>` ids active across the
 * whole iframe tree (each iframe contributes its own DOM contexts;
 * inner-iframe contexts come first, then the parent's wrapping
 * contexts). Shortcuts with a `when` clause are filtered against this
 * stack; conflict resolution prefers the binding whose `when` matches
 * the innermost-active context.
 */
const focusStateSchema = zod.object({
  iframes: zod.array(viewChainEntrySchema).default([]),
  contexts: zod.array(zod.string()).default([]),
});

const schema = createSchema({
  /**
   *
   * this needs to be changed, and we probably
   * should have an api for reading in memory state
   * on the service so we don't need to do these hacks
   *
   * */
  lastKnownViewRegistry: f.array(viewRegistryEntrySchema).default([]),
  /**
   * Single source of truth for all renderer-loaded plugin
   * registrations: functions, component views, advice, content
   * scripts. The renderer's reconciler watches this list, diffs
   * against its locally-applied state, and dynamic-imports + applies
   * new or changed entries (and cleans up removals). See
   * `registrationSchema` for the discriminated union.
   *
   * Iframe views are *not* in here — they don't load a module into
   * the renderer realm, they get rendered as `<iframe src=URL>`.
   * `lastKnownViewRegistry` continues to track those.
   */
  registrations: f.array(registrationSchema).default([]),
  windowPrefs: f.record(zod.string(), windowPrefsSchema).default({}),
  /**
   * Per-shortcut binding override. The full list of available shortcuts
   * (id, name, default binding) lives in memory inside
   * `ShortcutsService` — only user customizations are persisted. A null
   * value means "explicitly disabled". A missing entry means "use the
   * default".
   */
  shortcuts: f
    .record(zod.string(), shortcutBindingSchema.nullable())
    .default({}),
  /**
   * Live focus state. Includes both the iframe focus chain and the
   * flattened `<FocusContext>` id stack so shortcuts can be filtered
   * by `when`. See `focusStateSchema`. Updated by
   * `ShortcutsService.setFocus` from the renderer bridge.
   */
  focus: f
    .object({
      iframes: zod.array(viewChainEntrySchema).default([]),
      contexts: zod.array(zod.string()).default([]),
    })
    .default({ iframes: [], contexts: [] }),
});

export default schema;
export { schema };

export type ViewRegistryEntry = zod.infer<typeof viewRegistryEntrySchema>;
export type Registration = zod.infer<typeof registrationSchema>;
export type FunctionRegistration = zod.infer<typeof functionRegistrationSchema>;
export type ComponentViewRegistration = zod.infer<typeof componentViewRegistrationSchema>;
export type AdviceRegistration = zod.infer<typeof adviceRegistrationSchema>;
export type ContentScriptRegistration = zod.infer<typeof contentScriptRegistrationSchema>;
export type WindowBounds = zod.infer<typeof windowBoundsSchema>;
export type WindowPrefs = zod.infer<typeof windowPrefsSchema>;
export type ShortcutBinding = zod.infer<typeof shortcutBindingSchema>;
export type ViewChainEntry = zod.infer<typeof viewChainEntrySchema>;
export type FocusState = zod.infer<typeof focusStateSchema>;
export type SchemaRoot = InferSchemaRoot<typeof schema>;
export type CoreSchema = typeof schema.shape;
