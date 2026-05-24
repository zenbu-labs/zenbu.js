import zod from "zod";
import { createSchema, f, type InferSchemaRoot } from "@zenbu/kyju/schema";

const viewRegistryEntrySchema = zod.object({
  type: zod.string(),
  url: zod.string(),
  port: zod.number(),
  icon: zod.string().optional(),
  meta: zod
    .object({
      kind: zod.string().optional(),
      sidebar: zod.boolean().optional(),
      bottomPanel: zod.boolean().optional(),
      label: zod.string().optional(),
    })
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
export type WindowBounds = zod.infer<typeof windowBoundsSchema>;
export type WindowPrefs = zod.infer<typeof windowPrefsSchema>;
export type ShortcutBinding = zod.infer<typeof shortcutBindingSchema>;
export type ViewChainEntry = zod.infer<typeof viewChainEntrySchema>;
export type FocusState = zod.infer<typeof focusStateSchema>;
export type SchemaRoot = InferSchemaRoot<typeof schema>;
export type CoreSchema = typeof schema.shape;
