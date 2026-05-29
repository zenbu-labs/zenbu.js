export type Events = {
  advice: {
    /**
     * Fired when an injection registration changes (add / remove /
     * replace). The renderer's `ZenbuProvider` reloads when this
     * fires with `type: "*"` so the regenerated injection prelude
     * is re-imported.
     */
    reload: { type: string };
  };
  shortcuts: {
    /**
     * Broadcast whenever the set of registered shortcut definitions
     * or user-configured bindings changes. The renderer's
     * `ShortcutDispatcher` re-fetches `bindings()` so its local
     * `preventDefault()` cache stays in sync.
     */
    changed: {};
  };
  pluginUpdater: {
    /** Emitted after a repo check completes. */
    checked: { result: unknown };
    /** Best-effort progress for the one-shot apply path. */
    applying: {
      repoPath: string;
      phase: "closing" | "shutdown" | "git" | "install" | "relaunch";
      message?: string;
    };
    /** Emitted for check failures and pre-relaunch apply failures. */
    failed: {
      repoPath: string;
      phase: "check" | "closing" | "shutdown" | "git" | "install" | "relaunch";
      message: string;
    };
  };
};
