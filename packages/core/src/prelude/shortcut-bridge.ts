/**
 * Shortcut + focus bridge installed into every Zenbu iframe (and the
 * top-level entrypoint) by the advice prelude.
 *
 * Responsibilities:
 *
 *   1. Forward local `keydown` (capture phase) up via postMessage,
 *      `preventDefault()`-ing first if the key matches any cached
 *      binding so e.g. Cmd+P doesn't open the browser print dialog.
 *
 *   2. Forward local focus changes up so the host can track which
 *      pane the user is interacting with (= which iframe currently
 *      owns focus). The chain is built bottom-up: every iframe
 *      prepends its own viewType as the message bubbles toward the
 *      entrypoint.
 *
 *   3. Listen for `zenbu:bindings` from its parent and cache the
 *      list so its local matcher can decide whether to call
 *      `preventDefault()` synchronously.
 *
 *   4. Re-broadcast `zenbu:bindings` into its own child iframes when
 *      it receives one (so the entrypoint only needs to send it to
 *      its direct children).
 *
 * In the entrypoint (where `window.top === window`) we dispatch the
 * bubbled messages as `CustomEvent` on `window` instead of
 * postMessage-ing further. The React-side bridge listens for those
 * events and calls the core ShortcutsService RPC.
 */

interface KeyBindingInput {
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

interface BindingWhenObject {
  all?: string[];
  any?: string[];
  not?: string | string[];
}

type BindingWhen = string | string[] | BindingWhenObject;

interface BindingEntry {
  bindings?: KeyBindingInput[];
  when?: BindingWhen;
}

interface BridgeMessage {
  kind: string;
  input?: KeyBindingInput;
  chain?: Array<{ viewType: string }>;
  contexts?: string[];
  bindings?: BindingEntry[];
}

export function installShortcutBridge(viewType: string): void {
  const VIEW_TYPE = viewType;
  const isTop = window.top === window;

  // Cached binding list pushed from the entrypoint. Each entry is
  // { bindings, when? } so we can locally filter preventDefault by
  // the current active context stack.
  let bindings: BindingEntry[] = [];

  // Locally-tracked active focus-context ids for THIS document,
  // innermost first. Updated on focusin/focusout/pointerdown by
  // walking ancestors with [data-zenbu-focus-context]. Cross-iframe
  // merging is owned by the entrypoint bridge — we just report ours
  // and consume the merged stack it pushes back.
  let localContexts: string[] = [];

  // Merged active stack across the whole iframe tree, pushed down
  // from the entrypoint via 'zenbu:active-contexts'. Used by
  // shouldPreventDefault. The entrypoint resolves "merged" by
  // concatenating the focused iframe's local stack with its own.
  let activeContexts: string[] = [];

  function matches(input: KeyboardEvent, b: KeyBindingInput): boolean {
    if (!!b.meta !== !!input.metaKey) return false;
    if (!!b.control !== !!input.ctrlKey) return false;
    if (!!b.alt !== !!input.altKey) return false;
    if (!!b.shift !== !!input.shiftKey) return false;
    if (b.code && input.code !== b.code) return false;
    if (b.key) {
      const want = String(b.key).toLowerCase();
      const have = String(input.key || "").toLowerCase();
      if (have !== want) return false;
    }
    return true;
  }

  function whenMatches(w: BindingWhen | undefined, active: string[]): boolean {
    if (w == null) return true;
    const set: Record<string, boolean> = {};
    for (const c of active) set[c] = true;
    if (typeof w === "string") return !!set[w];
    if (Array.isArray(w)) {
      for (const id of w) if (!set[id]) return false;
      return true;
    }
    if (w.all) {
      for (const id of w.all) if (!set[id]) return false;
    }
    if (w.any) {
      let hit = false;
      for (const id of w.any)
        if (set[id]) {
          hit = true;
          break;
        }
      if (!hit) return false;
    }
    if (w.not) {
      const nots = Array.isArray(w.not) ? w.not : [w.not];
      for (const id of nots) if (set[id]) return false;
    }
    return true;
  }

  function shouldPreventDefault(ev: KeyboardEvent): boolean {
    // A binding's 'when' is checked against the *merged* active stack
    // (entrypoint + focused iframe). If we haven't received one yet
    // we fall back to our local stack so the very first keystrokes
    // after mount still behave correctly within this iframe.
    const active =
      activeContexts.length > 0 ? activeContexts : localContexts;
    for (const entry of bindings) {
      const bs = entry.bindings || [];
      let keyMatch = false;
      for (const b of bs) {
        if (matches(ev, b)) {
          keyMatch = true;
          break;
        }
      }
      if (!keyMatch) continue;
      if (!whenMatches(entry.when, active)) continue;
      return true;
    }
    return false;
  }

  function send(msg: BridgeMessage): void {
    if (isTop) {
      try {
        window.dispatchEvent(
          new CustomEvent("zenbu:bridge-message", { detail: msg }),
        );
      } catch {}
    } else {
      try {
        window.parent.postMessage(msg, "*");
      } catch {}
    }
  }

  // Broadcast a payload into every direct-child iframe. Children's
  // preludes re-broadcast, so this fans out into the whole tree.
  function fanout(msg: BridgeMessage): void {
    const frames = document.querySelectorAll("iframe");
    for (const frame of Array.from(frames)) {
      try {
        (frame as HTMLIFrameElement).contentWindow?.postMessage(msg, "*");
      } catch {}
    }
  }

  // Walk up from el collecting every [data-zenbu-focus-context]
  // ancestor. Returns the id list innermost-first. We split on whitespace
  // so a single wrapper can declare multiple ids (`data-...="a b"`),
  // mirroring how `class` works.
  function readContextChain(el: Element | null): string[] {
    const out: string[] = [];
    let node: Node | null = el;
    while (node && node.nodeType === 1) {
      const attr = (node as Element).getAttribute?.(
        "data-zenbu-focus-context",
      );
      if (attr) {
        const parts = String(attr).split(/\s+/);
        for (const id of parts) if (id) out.push(id);
      }
      node = node.parentNode;
    }
    return out;
  }

  function updateLocalContexts(el: Element | null): void {
    const next = readContextChain(el);
    // Cheap equality check to skip redundant postMessages.
    if (next.length === localContexts.length) {
      let same = true;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== localContexts[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    localContexts = next;
    send({
      kind: "zenbu:view-focus",
      chain: [{ viewType: VIEW_TYPE }],
      contexts: localContexts.slice(),
    });
  }

  window.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      if (ev.defaultPrevented) return;
      const input: KeyBindingInput = {
        key: ev.key,
        code: ev.code,
        meta: !!ev.metaKey,
        control: !!ev.ctrlKey,
        alt: !!ev.altKey,
        shift: !!ev.shiftKey,
      };
      if (shouldPreventDefault(ev)) {
        try {
          ev.preventDefault();
        } catch {}
        try {
          ev.stopPropagation();
        } catch {}
      }
      const active =
        activeContexts.length > 0 ? activeContexts : localContexts;
      send({
        kind: "zenbu:view-keydown",
        input,
        chain: [{ viewType: VIEW_TYPE }],
        contexts: active.slice(),
      });
    },
    true,
  );

  function onFocusEvent(ev: FocusEvent): void {
    updateLocalContexts(
      (ev.target as Element | null) ?? document.activeElement,
    );
  }

  // focusin/focusout bubble (focus/blur don't). pointerdown catches
  // clicks on non-focusable rows so list UIs still "enter" the context
  // — the FocusContext component on the renderer side routes such
  // clicks to focus the wrapper, but we listen here too in case a
  // plugin builds its own context without going through React.
  document.addEventListener("focusin", onFocusEvent, true);
  document.addEventListener(
    "focusout",
    () => {
      // After focus leaves, recompute relative to the new activeElement
      // (typically <body>). A microtask wait lets the new focus settle.
      Promise.resolve().then(() => updateLocalContexts(document.activeElement));
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (ev: PointerEvent) => {
      // Read from the click target directly — the focus event that
      // follows is the authoritative source, but reading the target now
      // closes the gap for non-focusable hits.
      updateLocalContexts(ev.target as Element | null);
    },
    true,
  );

  // Initial report: the document might have already-focused content by
  // the time the prelude runs (e.g. autofocused inputs).
  updateLocalContexts(document.activeElement);

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as BridgeMessage | undefined;
    if (!d || typeof d !== "object") return;
    if (d.kind === "zenbu:view-keydown" || d.kind === "zenbu:view-focus") {
      // Bubble up, prepending our own view to the chain so the
      // entrypoint sees the path from outer to inner. Also prepend
      // our own local contexts to whatever the child reported — the
      // child's contexts are deeper, ours wrap them.
      const nextChain = [{ viewType: VIEW_TYPE }].concat(
        Array.isArray(d.chain) ? d.chain : [],
      );
      const childContexts = Array.isArray(d.contexts) ? d.contexts : [];
      const mergedContexts = childContexts.concat(localContexts);
      send({
        kind: d.kind,
        input: d.input,
        chain: nextChain,
        contexts: mergedContexts,
      });
      return;
    }
    if (d.kind === "zenbu:bindings") {
      bindings = Array.isArray(d.bindings) ? d.bindings : [];
      fanout(d);
      return;
    }
    if (d.kind === "zenbu:active-contexts") {
      activeContexts = Array.isArray(d.contexts) ? d.contexts : [];
      fanout(d);
      return;
    }
    if (d.kind === "zenbu:request-bindings") {
      // A child asks for the current bindings. We don't know them at
      // any non-top level until the entrypoint pushes them down, so
      // re-emit the request upward; the entrypoint replies with a
      // fan-out that travels back down.
      if (isTop) {
        try {
          window.dispatchEvent(
            new CustomEvent("zenbu:bridge-message", { detail: d }),
          );
        } catch {}
      } else {
        try {
          window.parent.postMessage(d, "*");
        } catch {}
      }
      return;
    }
  });

  // Ask upward for the current bindings on load. The entrypoint
  // responds with a zenbu:bindings fan-out.
  if (!isTop) {
    try {
      window.parent.postMessage({ kind: "zenbu:request-bindings" }, "*");
    } catch {}
  }
}
