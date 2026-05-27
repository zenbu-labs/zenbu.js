export type Events = {
  advice: {
    /**
     * Fired when an advice / content-script / component-view /
     * function-source registration changes. The renderer reloads the
     * iframe when `type` matches its view or is `"*"`, picking up the
     * regenerated prelude.
     */
    reload: { type: string };
  };
  shortcuts: {
    /**
     * Broadcast whenever the set of registered shortcut definitions or
     * user-configured bindings changes. The renderer subscribes to push
     * the current binding list down into every iframe so the prelude
     * can `preventDefault()` matching shortcuts synchronously.
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
