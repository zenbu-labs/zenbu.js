import { nanoid } from "nanoid";
import { unlinkSync, existsSync } from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpClient, type AcpClientConfig, PROTOCOL_VERSION } from "./client";
import type { AgentDb, AgentEvent, ConfigOption } from "./schema";
import { getMcpSocketPath } from "./mcp/socket-path";
import { writeProxyScript } from "./mcp/proxy-template";
import { TerminalManager } from "./terminal";
import {
  serializeEventLog,
  truncateToTokenBudget,
} from "./serialize-event-log";

export type AgentState =
  | { kind: "initializing" }
  | { kind: "ready"; sessionId: string }
  | { kind: "prompting"; sessionId: string }
  | { kind: "error"; error: unknown }
  | { kind: "closed" };

const LIVE_ONLY_PROCESS_STATES = new Set(["initializing", "prompting"]);

export async function reconcileAgentDbProcessState(
  db: AgentDb,
  activeAgentIds: Iterable<string>,
): Promise<void> {
  const active = new Set(activeAgentIds);
  await db.update((root) => {
    for (const agent of root.agents) {
      if (active.has(agent.id)) continue;

      const staleLiveState =
        agent.status === "streaming" ||
        (agent.processState
          ? LIVE_ONLY_PROCESS_STATES.has(agent.processState)
          : false);

      if (!staleLiveState) continue;

      const wasStreaming = agent.status === "streaming";
      agent.status = "idle";
      agent.processState = "ready";
      if (wasStreaming) {
        agent.lastFinishedAt = Date.now();
      }
    }
  });
}

export type BeforeCreateListener = (
  agentId: string,
  socketPath: string,
) => Promise<void>;
export type DestroyListener = (agentId: string, socketPath: string) => void;

export type AgentConfig = {
  id?: string;
  clientConfig: AcpClientConfig;
  cwd: string;
  mcpServers?: acp.McpServer[];
  /** Kyju-backed persistence; when omitted the agent runs ephemeral (in-memory, no DB writes). */
  db?: AgentDb;
  /** Path to a node-compatible runtime for the MCP proxy script; if omitted, the proxy server isn't registered. */
  mcpProxyCommand?: string;
  /** Pure observer of state transitions; the Agent handles its own DB state sync when `db` is present. */
  onStateChange?: (state: AgentState) => void;
  /** Observes every ACP session update without persisting; used by one-shot sub-agents. */
  onSessionUpdate?: (update: acp.SessionUpdate) => void;
  /**
   * Invoked once on the first prompt; returned blocks are prepended to the
   * prompt. Blocks the send (failures non-fatal); "already fired" is durable
   * via `db` when present, else scoped to this instance.
   */
  firstPromptPreamble?: () => Promise<acp.ContentBlock[]>;
};

type AcpConfigExtract = {
  availableModels: ConfigOption[];
  availableThinkingLevels: ConfigOption[];
  availableModes: ConfigOption[];
  defaultModel: string;
  defaultThinkingLevel: string;
  defaultMode: string;
};

/** Extract structured values from the raw ACP configOptions array. */
function extractAcpConfig(acpOptions: any[]): AcpConfigExtract {
  const modelOpt = acpOptions.find(
    (o: any) => o.category === "model" && o.type === "select",
  );
  const thinkingOpt = acpOptions.find(
    (o: any) => o.category === "thought_level" && o.type === "select",
  );
  const modeOpt = acpOptions.find(
    (o: any) => o.category === "mode" && o.type === "select",
  );
  const mapOptions = (options: any[]): ConfigOption[] =>
    options
      .filter((o: any) => "value" in o)
      .map((o: any) => ({
        value: o.value,
        name: o.name,
        ...(typeof o.description === "string" && o.description
          ? { description: o.description }
          : {}),
      }));
  return {
    availableModels: modelOpt ? mapOptions(modelOpt.options ?? []) : [],
    availableThinkingLevels: thinkingOpt
      ? mapOptions(thinkingOpt.options ?? [])
      : [],
    availableModes: modeOpt ? mapOptions(modeOpt.options ?? []) : [],
    defaultModel: modelOpt?.currentValue ?? "",
    defaultThinkingLevel: thinkingOpt?.currentValue ?? "",
    defaultMode: modeOpt?.currentValue ?? "",
  };
}

/** If the agent's current selection is no longer valid against ACP's
 * available options, snap back to the new default. Mutates in place. */
function reconcileInstanceSelections(
  agent: { model?: string; thinkingLevel?: string; mode?: string },
  extracted: AcpConfigExtract,
) {
  if (agent.model && extracted.availableModels.length > 0) {
    if (!extracted.availableModels.some((m) => m.value === agent.model)) {
      agent.model =
        extracted.defaultModel || extracted.availableModels[0]?.value;
    }
  }
  if (agent.thinkingLevel && extracted.availableThinkingLevels.length > 0) {
    if (
      !extracted.availableThinkingLevels.some(
        (t) => t.value === agent.thinkingLevel,
      )
    ) {
      agent.thinkingLevel =
        extracted.defaultThinkingLevel ||
        extracted.availableThinkingLevels[0]?.value;
    }
  }
  if (agent.mode && extracted.availableModes.length > 0) {
    if (!extracted.availableModes.some((m) => m.value === agent.mode)) {
      agent.mode = extracted.defaultMode || extracted.availableModes[0]?.value;
    }
  }
}

type InitLatch = {
  promise: Promise<void>;
  resolve: () => void;
};

function makeInitLatch(): InitLatch {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class Agent {
  private static beforeCreateListeners = new Set<BeforeCreateListener>();
  private static destroyListeners = new Set<DestroyListener>();

  static onBeforeCreate(listener: BeforeCreateListener): () => void {
    Agent.beforeCreateListeners.add(listener);
    return () => {
      Agent.beforeCreateListeners.delete(listener);
    };
  }

  static onDestroy(listener: DestroyListener): () => void {
    Agent.destroyListeners.add(listener);
    return () => {
      Agent.destroyListeners.delete(listener);
    };
  }

  private id: string;
  private socketPath: string;
  private state: AgentState = { kind: "initializing" };
  private initLatch: InitLatch;
  private client: AcpClient;
  private clientConfig: AcpClientConfig;
  private db: AgentDb | undefined;
  private cwd: string;
  private mcpServers: acp.McpServer[];
  private onStateChange?: (state: AgentState) => void;
  private onSessionUpdate?: (update: acp.SessionUpdate) => void;
  private _terminalManager: TerminalManager;
  private initialContext: acp.ContentBlock[] | null = null;
  private firstPromptPreamble?: () => Promise<acp.ContentBlock[]>;
  // Ephemeral-mode fallbacks used when `db` is absent.
  private _ephemeralSessionId: string | null = null;
  private _ephemeralFirstFired = false;
  private supportsLoadSession = false;
  private pendingHandoffContext: string | null = null;
  private eventBuffer: AgentEvent[] = [];

  private _unsubSessionUpdate: (() => void) | null = null;
  private _unsubEventLog: (() => void) | null = null;

  /**
   * Pending permission requests awaiting a `permission_response` event in
   * the event log. When the request goes out we stash a resolver here keyed
   * by requestId; our eventLog subscription resolves it when the user (or
   * any writer) records the response.
   */
  private _pendingPermissions = new Map<
    string,
    (outcome: import("./schema").PermissionOutcome) => void
  >();

  private constructor(
    id: string,
    socketPath: string,
    initLatch: InitLatch,
    client: AcpClient,
    clientConfig: AcpClientConfig,
    db: AgentDb | undefined,
    cwd: string,
    mcpServers: acp.McpServer[],
    terminalManager: TerminalManager,
    onStateChange?: (state: AgentState) => void,
    onSessionUpdate?: (update: acp.SessionUpdate) => void,
    firstPromptPreamble?: () => Promise<acp.ContentBlock[]>,
  ) {
    this.id = id;
    this.socketPath = socketPath;
    this.initLatch = initLatch;
    this.client = client;
    this.clientConfig = clientConfig;
    this.db = db;
    this.cwd = cwd;
    this.mcpServers = mcpServers;
    this._terminalManager = terminalManager;
    this.onStateChange = onStateChange;
    this.onSessionUpdate = onSessionUpdate;
    this.firstPromptPreamble = firstPromptPreamble;
  }

  /**
   * Session/first-prompt/event-log persistence — consolidated from the old
   * AgentStore/EventLog/FirstPromptLatch interfaces. All four methods
   * no-op cleanly when `db` is absent (ephemeral mode).
   */
  private _getSessionId(): string | null {
    if (this.db) {
      return (
        this.db.readRoot().agents.find((a) => a.id === this.id)?.sessionId ??
        null
      );
    }
    return this._ephemeralSessionId;
  }

  private async _setSessionId(sessionId: string | null): Promise<void> {
    if (!this.db) {
      this._ephemeralSessionId = sessionId;
      return;
    }
    try {
      await this.db.update((root) => {
        const a = root.agents.find((x) => x.id === this.id);
        if (a) a.sessionId = sessionId;
      });
    } catch (err) {
      console.warn(`[agent ${this.id}] setSessionId failed:`, err);
    }
  }

  private _firstPromptHasFired(): boolean {
    if (this.db) {
      return (
        this.db.readRoot().agents.find((a) => a.id === this.id)
          ?.firstPromptSentAt != null
      );
    }
    return this._ephemeralFirstFired;
  }

  private async _firstPromptMarkFired(): Promise<void> {
    if (!this.db) {
      this._ephemeralFirstFired = true;
      return;
    }
    try {
      await this.db.update((root) => {
        const a = root.agents.find((x) => x.id === this.id);
        if (a) a.firstPromptSentAt = Date.now();
      });
    } catch (err) {
      console.warn(
        `[agent ${this.id}] firstPrompt markFired failed:`,
        err,
      );
    }
  }

  private _appendEventLog(events: AgentEvent[]): void {
    if (!this.db || events.length === 0) return;
    const node = this.db.agents.find((a) => a.id === this.id);
    if (!node) return;
    // Fire-and-forget: eventLog writes shouldn't block callers, but we still
    // want to surface failures in logs.
    node.eventLog.concat(events).catch((err) => {
      console.warn(`[agent ${this.id}] eventLog.concat failed:`, err);
    });
  }

  private _subscribeSessionUpdates() {
    this._unsubSessionUpdate?.();
    this._unsubSessionUpdate = this.client.onSessionUpdate(
      (e: acp.SessionNotification) => {
        const event: AgentEvent = {
          timestamp: Date.now(),
          data: { kind: "session_update", update: e.update },
        };
        this.eventBuffer.push(event);
        this._appendEventLog([event]);
        this.onSessionUpdate?.(e.update);

        const update = e.update as any;
        if (update?.configOptions) {
          // Fire-and-forget: reconcile is best-effort state-sync, don't await.
          this._reconcileConfigChange(update.configOptions).catch((err) => {
            console.warn(`[agent ${this.id}] reconcileConfigChange failed:`, err);
          });
        }
      },
    );
  }

  private _logSyntheticEvent(data: AgentEvent["data"]) {
    const event: AgentEvent = { timestamp: Date.now(), data };
    this.eventBuffer.push(event);
    this._appendEventLog([event]);
  }

  private async _setState(state: AgentState): Promise<void> {
    this.state = state;
    this.onStateChange?.(state);
    // Sync the state projection onto the agent's DB record:
    //   processState: string form of the state machine kind
    //   status:       "streaming" while prompting, "idle" otherwise
    //   lastFinishedAt: timestamp of the last transition away from "prompting"
    if (this.db) {
      const status: "idle" | "streaming" =
        state.kind === "prompting" ? "streaming" : "idle";
      try {
        await this.db.update((root) => {
          const a = root.agents.find((x) => x.id === this.id);
          if (!a) return;
          a.processState = state.kind;
          const previousStatus = a.status;
          a.status = status;
          if (previousStatus === "streaming" && status === "idle") {
            a.lastFinishedAt = Date.now();
          }
        });
      } catch (err) {
        console.warn(`[agent ${this.id}] state sync failed:`, err);
      }
    }
  }

  /**
   * Reconcile ACP-advertised config options with the DB on session start.
   *
   * ACP sends `configOptions` in its newSession response; this is our
   * authoritative list of available models / thinking levels / modes. We:
   *   - Overwrite the template's availableModels/ThinkingLevels/Modes so the
   *     UI reflects what ACP currently offers.
   *   - Seed defaults onto the agent instance for any currently-unset fields.
   *   - Re-validate all sibling agents sharing the same configId (e.g. stale
   *     `model` values get snapped to the new default if removed).
   *   - Push the user's pre-existing selections back to ACP when they're
   *     still in the available set (e.g. we remember "gpt-5" across session
   *     re-inits).
   */
  private async _reconcileConfigOptions(
    options: any[],
    sessionId: string,
  ): Promise<void> {
    if (!this.db) return;
    const extracted = extractAcpConfig(options);

    const preExisting = this.db
      .readRoot()
      .agents.find((a) => a.id === this.id);
    const preModel = preExisting?.model;
    const preThinking = preExisting?.thinkingLevel;
    const preMode = preExisting?.mode;

    await this.db
      .update((root) => {
        const instance = root.agents.find((a) => a.id === this.id);
        const configId = instance?.configId;
        if (configId) {
          const template = root.agentConfigs.find((c) => c.id === configId);
          if (template) {
            template.availableModels = extracted.availableModels;
            template.availableThinkingLevels =
              extracted.availableThinkingLevels;
            template.availableModes = extracted.availableModes;
            // Bootstrap the template's defaultConfiguration on first
            // handshake for this kind — so newly-created agents have
            // something to seed from before the user has ever picked a
            // value explicitly. The user's own toolbar selections (via
            // setSessionConfigOption) still take precedence because they
            // overwrite these fields unconditionally.
            if (!template.defaultConfiguration) {
              template.defaultConfiguration = {};
            }
            if (!template.defaultConfiguration.model && extracted.defaultModel) {
              template.defaultConfiguration.model = extracted.defaultModel;
            }
            if (
              !template.defaultConfiguration.thinkingLevel &&
              extracted.defaultThinkingLevel
            ) {
              template.defaultConfiguration.thinkingLevel =
                extracted.defaultThinkingLevel;
            }
            if (!template.defaultConfiguration.mode && extracted.defaultMode) {
              template.defaultConfiguration.mode = extracted.defaultMode;
            }
          }
        }
        if (instance) {
          if (!instance.model && extracted.defaultModel) {
            instance.model = extracted.defaultModel;
          }
          if (!instance.thinkingLevel && extracted.defaultThinkingLevel) {
            instance.thinkingLevel = extracted.defaultThinkingLevel;
          }
          if (!instance.mode && extracted.defaultMode) {
            instance.mode = extracted.defaultMode;
          }
        }
        if (configId) {
          for (const sibling of root.agents) {
            if (sibling.configId !== configId) continue;
            reconcileInstanceSelections(sibling, extracted);
          }
        }
      })
      .catch(() => {});

    // Restore user-preferred selections to ACP if still valid. Calls the
    // low-level AcpClient directly (not `setSessionConfigOption`) because
    // we're inside `_initSession` and the high-level method waits on
    // `initLatch`, which wouldn't resolve until this function returns —
    // deadlock.
    const pushAcp = async (configId: string, value: string) => {
      try {
        await this.client.setSessionConfigOption({
          sessionId,
          configId,
          value,
        });
      } catch {}
    };

    if (
      preModel &&
      preModel !== extracted.defaultModel &&
      (!extracted.availableModels.length ||
        extracted.availableModels.some((m) => m.value === preModel))
    ) {
      await pushAcp("model", preModel);
    }
    if (
      preThinking &&
      preThinking !== extracted.defaultThinkingLevel &&
      (!extracted.availableThinkingLevels.length ||
        extracted.availableThinkingLevels.some(
          (t) => t.value === preThinking,
        ))
    ) {
      await pushAcp("reasoning_effort", preThinking);
    }
    if (
      preMode &&
      preMode !== extracted.defaultMode &&
      (!extracted.availableModes.length ||
        extracted.availableModes.some((m) => m.value === preMode))
    ) {
      await pushAcp("mode", preMode);
    }
  }

  /**
   * React to mid-session ACP config changes (e.g. the user switched models
   * in the ACP-side UI). Overwrites both the template's available options
   * and this agent instance's current selection, and snaps sibling agents
   * to the new defaults if their current selections fell out of range.
   */
  private async _reconcileConfigChange(options: any[]): Promise<void> {
    if (!this.db) return;
    const extracted = extractAcpConfig(options);

    await this.db
      .update((root) => {
        const instance = root.agents.find((a) => a.id === this.id);
        if (!instance) return;

        const configId = instance.configId;
        if (configId) {
          const template = root.agentConfigs.find((c) => c.id === configId);
          if (template) {
            template.availableModels = extracted.availableModels;
            template.availableThinkingLevels =
              extracted.availableThinkingLevels;
            template.availableModes = extracted.availableModes;
          }
        }

        if (extracted.defaultModel) instance.model = extracted.defaultModel;
        if (extracted.defaultThinkingLevel)
          instance.thinkingLevel = extracted.defaultThinkingLevel;
        if (extracted.defaultMode) instance.mode = extracted.defaultMode;

        if (configId) {
          for (const sibling of root.agents) {
            if (sibling.id === this.id || sibling.configId !== configId)
              continue;
            reconcileInstanceSelections(sibling, extracted);
          }
        }
      })
      .catch(() => {});
  }

  private _buildClientConfig(base: AcpClientConfig): AcpClientConfig {
    const tm = this._terminalManager;
    const agent = this;
    return {
      ...base,
      handlers: {
        // Default permission handler routes through the event log (so the
        // UI can render the prompt and the user's response flows back via
        // a synthetic event). Only applied when the caller didn't supply
        // one AND we have a DB — without a DB there's no event log to
        // write to, so AcpClient's fallback (auto-allow) takes over.
        ...(base.handlers?.requestPermission || !agent.db
          ? {}
          : {
              requestPermission: (params: acp.RequestPermissionRequest) =>
                agent._handleRequestPermission(params),
            }),
        ...base.handlers,
        createTerminal: (params) => Promise.resolve(tm.create(params)),
        terminalOutput: (params) =>
          Promise.resolve(tm.getOutput(params.terminalId)),
        releaseTerminal: (params) =>
          Promise.resolve(tm.release(params.terminalId)),
        waitForTerminalExit: (params) => tm.waitForExit(params.terminalId),
        killTerminal: (params) => Promise.resolve(tm.kill(params.terminalId)),
      },
    };
  }

  /**
   * Default permission handler. Writes a `permission_request` event into
   * the agent's eventLog and returns a promise that resolves when a
   * matching `permission_response` lands (via our eventLog subscription).
   *
   * The UI reads the request out of the event log via the standard
   * materializer and, when the user clicks a choice, writes the response
   * as another event — no direct RPC to the agent process needed.
   */
  private _handleRequestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = nanoid();
    const promise = new Promise<acp.RequestPermissionResponse>((resolve) => {
      this._pendingPermissions.set(requestId, (outcome) => {
        resolve({ outcome } as acp.RequestPermissionResponse);
      });
    });
    this._logSyntheticEvent({
      kind: "permission_request",
      requestId,
      toolCall: params.toolCall,
      options: params.options,
    });
    return promise;
  }

  /**
   * Subscribe to the agent's own eventLog so we can react to
   * `permission_response` events. Fires once per agent instance after the
   * row exists in the DB. No-op in ephemeral mode (no db, no eventLog
   * collection, no permission flow — AcpClient's auto-allow default wins).
   */
  private _subscribeEventLog() {
    if (!this.db) return;
    this._unsubEventLog?.();
    const node = this.db.agents.find((a) => a.id === this.id);
    if (!node) return;
    this._unsubEventLog = node.eventLog.subscribeData(({ newItems }) => {
      for (const item of newItems as AgentEvent[]) {
        if (item.data?.kind !== "permission_response") continue;
        const { requestId, outcome } = item.data;
        const resolver = this._pendingPermissions.get(requestId);
        if (resolver) {
          this._pendingPermissions.delete(requestId);
          resolver(outcome);
        }
      }
    });
  }

  private async _initSession(opts?: { freshSession?: boolean }): Promise<void> {
    try {
      const initResult = await this.client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: true },
        },
      });
      this.supportsLoadSession = !!initResult.agentCapabilities?.loadSession;
      this._logSyntheticEvent({
        kind: "initialize",
        agentCapabilities: initResult.agentCapabilities,
      });

      const existingSessionId = opts?.freshSession
        ? null
        : this._getSessionId();

      let sessionId: string;
      if (existingSessionId) {
        if (!this.supportsLoadSession) {
          this._generateHandoff();
          const session = await this.client.newSession({
            cwd: this.cwd,
            mcpServers: this.mcpServers,
          });
          sessionId = session.sessionId;
          await this._setSessionId(sessionId);
          this._logSyntheticEvent({
            kind: "new_session",
            sessionId,
            configOptions: session.configOptions,
            modes: session.modes,
          });
          if (session.configOptions) {
            await this._reconcileConfigOptions(
              session.configOptions,
              sessionId,
            );
          }
        } else {
          let resumed: acp.ResumeSessionResponse | null = null;
          try {
            resumed = await this.client.resumeSession({
              sessionId: existingSessionId,
              cwd: this.cwd,
              mcpServers: this.mcpServers,
            });
          } catch {
            resumed = null;
          }
          if (resumed) {
            sessionId = existingSessionId;
            this._logSyntheticEvent({ kind: "resume_session", sessionId });
            // ACP doesn't accept initial mode/model/thinking in the resume
            // request — each session starts fresh on those axes until we
            // push our persisted selections back via setSessionConfigOption.
            // Without this, a relaunched agent reverts to ACP's defaults
            // for permission mode / model / thinking even though the DB
            // still records the user's picks.
            if (resumed.configOptions) {
              await this._reconcileConfigOptions(
                resumed.configOptions,
                sessionId,
              );
            }
          } else {
            this._generateHandoff();
            const session = await this.client.newSession({
              cwd: this.cwd,
              mcpServers: this.mcpServers,
            });
            sessionId = session.sessionId;
            await this._setSessionId(sessionId);
            this._logSyntheticEvent({
              kind: "new_session",
              sessionId,
              configOptions: session.configOptions,
              modes: session.modes,
            });
            if (session.configOptions) {
              await this._reconcileConfigOptions(
                session.configOptions,
                sessionId,
              );
            }
          }
        }
      } else {
        const session = await this.client.newSession({
          cwd: this.cwd,
          mcpServers: this.mcpServers,
        });
        sessionId = session.sessionId;
        await this._setSessionId(sessionId);
        this._logSyntheticEvent({
          kind: "new_session",
          sessionId,
          configOptions: session.configOptions,
          modes: session.modes,
        });
        if (session.configOptions) {
          await this._reconcileConfigOptions(
            session.configOptions,
            sessionId,
          );
        }
      }

      await this._setState({ kind: "ready", sessionId });
    } catch (err) {
      if (this.state.kind !== "closed") {
        await this._setState({ kind: "error", error: err });
      }
    } finally {
      this.initLatch.resolve();
    }
  }

  private _generateHandoff(): void {
    if (this.eventBuffer.length === 0) return;
    const { texts } = serializeEventLog(this.eventBuffer);
    if (texts.length === 0) return;
    const transcript = texts.join("\n\n");
    this.pendingHandoffContext = truncateToTokenBudget(
      `<handoff>\nThis is a continuation of a previous conversation with a different agent. Here is the transcript of that conversation for context:\n\n${transcript}\n</handoff>`,
    );
  }

  private async _restart(opts?: { freshSession?: boolean }): Promise<void> {
    this._terminalManager.releaseAll();
    await this.client.close();

    this.initLatch = makeInitLatch();
    await this._setState({ kind: "initializing" });

    const builtConfig = this._buildClientConfig(this.clientConfig);
    try {
      this.client = await AcpClient.create(builtConfig);
    } catch (err) {
      await this._setState({ kind: "error", error: err });
      this.initLatch.resolve();
      return;
    }
    this._subscribeSessionUpdates();
    this._subscribeEventLog();

    // Fire-and-forget the init; the next send() call awaits initLatch.
    void this._initSession(opts);
  }

  static async create(config: AgentConfig): Promise<Agent> {
    const id = config.id ?? nanoid();

    const hasToolListeners = Agent.beforeCreateListeners.size > 0;
    const socketPath = getMcpSocketPath(id);

    if (hasToolListeners) {
      await Promise.all(
        [...Agent.beforeCreateListeners].map((l) => l(id, socketPath)),
      );
    }

    // The zenbu MCP proxy exposes our in-process tool registry to the ACP
    // agent via stdio. It's only wired if BOTH conditions hold:
    //   1. Some caller registered tools (hasToolListeners) — otherwise
    //      there's nothing to expose.
    //   2. The host explicitly provided `mcpProxyCommand` pointing at a
    //      node-compatible runtime. Without this we can't safely spawn the
    //      proxy script; users may not have node on PATH. Silent fallback
    //      to "node" would cause ENOENT mid-handshake.
    let mcpServers: acp.McpServer[];
    if (hasToolListeners && config.mcpProxyCommand) {
      const proxyScriptPath = writeProxyScript(socketPath);
      const proxyMcpServer = {
        type: "stdio" as const,
        name: "zenbu",
        command: config.mcpProxyCommand,
        args: [proxyScriptPath],
        env: [],
      };
      mcpServers = [proxyMcpServer, ...(config.mcpServers ?? [])];
    } else {
      mcpServers = config.mcpServers ?? [];
    }

    const initLatch = makeInitLatch();
    const terminalManager = new TerminalManager();

    const baseClientConfig: AcpClientConfig = {
      ...config.clientConfig,
    };

    const agent = new Agent(
      id,
      socketPath,
      initLatch,
      null as any,
      baseClientConfig,
      config.db,
      config.cwd,
      mcpServers,
      terminalManager,
      config.onStateChange,
      config.onSessionUpdate,
      config.firstPromptPreamble,
    );

    const builtConfig = agent._buildClientConfig(baseClientConfig);
    agent.client = await AcpClient.create(builtConfig);
    agent._subscribeSessionUpdates();
    agent._subscribeEventLog();

    // Fire-and-forget the init; callers await `send()` which awaits initLatch.
    void agent._initSession();

    return agent;
  }

  getId = () => this.id;

  getSocketPath = () => this.socketPath;

  getTerminalManager = () => this._terminalManager;

  setInitialContext(content: acp.ContentBlock[]): void {
    this.initialContext = content;
  }

  private _applyHandoff(content: acp.ContentBlock[]): acp.ContentBlock[] {
    if (!this.pendingHandoffContext) return content;
    const result = [
      { type: "text", text: this.pendingHandoffContext } as acp.ContentBlock,
      ...content,
    ];
    this.pendingHandoffContext = null;
    return result;
  }

  /**
   * Resolve the first-prompt preamble for the next send. Checks the latch
   * (durable when `db` is present, in-memory otherwise), invokes the
   * provider once, and marks the latch even on failure/empty-result to
   * avoid retrying on every send.
   */
  private async _computePreamble(): Promise<acp.ContentBlock[]> {
    if (!this.firstPromptPreamble) return [];
    if (this._firstPromptHasFired()) return [];

    let blocks: acp.ContentBlock[];
    try {
      blocks = await this.firstPromptPreamble();
    } catch (err) {
      console.warn("[agent] firstPromptPreamble failed:", err);
      blocks = [];
    }

    await this._firstPromptMarkFired();
    return blocks;
  }

  private async _sendPrompt(
    sessionId: string,
    content: acp.ContentBlock[],
  ): Promise<void> {
    await this._setState({ kind: "prompting", sessionId });

    let prompt = content;
    if (this.initialContext) {
      prompt = [...this.initialContext, ...content];
      this.initialContext = null;
    }

    const preamble = await this._computePreamble().catch(() => [] as acp.ContentBlock[]);
    if (preamble.length > 0) {
      prompt = [...preamble, ...prompt];
    }

    await this.client.prompt({ sessionId, prompt });

    await this._setState({ kind: "ready", sessionId });
  }

  async send(content: acp.ContentBlock[]): Promise<void> {
    const userText = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (userText) {
      this.eventBuffer.push({
        timestamp: Date.now(),
        data: { kind: "user_prompt", text: userText },
      });
    }

    if (this.state.kind === "closed") {
      throw Object.assign(new Error("Agent is closed"), {
        code: "AGENT_CLOSED" as const,
      });
    }

    if (this.state.kind === "error") {
      throw Object.assign(new Error("Agent failed to initialize"), {
        code: "AGENT_ERROR" as const,
        cause: this.state.error,
      });
    }

    if (this.state.kind === "initializing") {
      await this.initLatch.promise;
      // `await` may have mutated this.state. Force a fresh read with an
      // explicit widening cast since TS still trusts the narrowed type from
      // before the await.
      const state = this.state as AgentState;
      if (state.kind === "error") {
        throw Object.assign(new Error("Agent failed to initialize"), {
          code: "AGENT_ERROR" as const,
          cause: state.error,
        });
      }
      if (state.kind === "closed") {
        throw new Error("Agent is closed");
      }
      if (state.kind === "ready") {
        await this._sendPrompt(
          state.sessionId,
          this._applyHandoff(content),
        );
      }
      return;
    }

    if (this.state.kind === "prompting") {
      throw Object.assign(new Error("Agent is busy (prompting)"), {
        code: "AGENT_BUSY" as const,
      });
    }

    const readyState = this.state;
    if (readyState.kind !== "ready") return;
    await this._sendPrompt(
      readyState.sessionId,
      this._applyHandoff(content),
    );
  }

  getState(): AgentState {
    return this.state;
  }

  getDebugState(): {
    id: string;
    state: AgentState["kind"];
    sessionId: string | null;
    command: string;
    args: string[];
    cwd: string;
    supportsLoadSession: boolean;
    hasPendingHandoff: boolean;
    eventBufferSize: number;
  } {
    const state = this.state;
    return {
      id: this.id,
      state: state.kind,
      sessionId:
        state.kind === "ready" || state.kind === "prompting"
          ? state.sessionId
          : null,
      command: this.clientConfig.command,
      args: this.clientConfig.args,
      cwd: this.cwd,
      supportsLoadSession: this.supportsLoadSession,
      hasPendingHandoff: this.pendingHandoffContext !== null,
      eventBufferSize: this.eventBuffer.length,
    };
  }

  async changeCwd(newCwd: string): Promise<void> {
    this.cwd = newCwd;
    this.clientConfig = { ...this.clientConfig, cwd: newCwd };
    await this._restart();
  }

  async changeStartCommand(command: string, args: string[]): Promise<void> {
    this._generateHandoff();
    await this._setSessionId(null);
    this.clientConfig = { ...this.clientConfig, command, args };
    await this._restart({ freshSession: true });
  }

  async setSessionConfigOption(
    configId: string,
    value: string,
  ): Promise<void> {
    await this.initLatch.promise;
    const state = this.state;
    if (state.kind === "error" || state.kind === "closed") return;
    const sessionId =
      state.kind === "ready" || state.kind === "prompting"
        ? state.sessionId
        : null;
    if (!sessionId) return;
    const result = await this.client.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });

    // Mirror the user's selection onto the live instance state
    // (`agents[i].{model|thinkingLevel|mode}`).
    //
    // For model/thinkingLevel we also write the template default so a
    // freshly-spawned agent of the same kind starts with the user's most
    // recent pick. Mode is deliberately excluded: selecting a mode for
    // one agent must not silently change what every new agent defaults
    // to. The mode default is seeded once from ACP on first handshake
    // (see `_reconcileConfigOptions`) and otherwise only changes via an
    // explicit "set as default" action in the UI.
    //
    // ACP configId -> record field mapping:
    //   "model" -> model
    //   "reasoning_effort" -> thinkingLevel
    //   "mode" -> mode
    if (this.db) {
      await this.db
        .update((root) => {
          const a = root.agents.find((x) => x.id === this.id);
          if (!a) return;
          if (configId === "model") a.model = value;
          else if (configId === "reasoning_effort") a.thinkingLevel = value;
          else if (configId === "mode") a.mode = value;

          const template = root.agentConfigs.find((c) => c.id === a.configId);
          if (template) {
            if (!template.defaultConfiguration) {
              template.defaultConfiguration = {};
            }
            if (configId === "model") {
              template.defaultConfiguration.model = value;
            } else if (configId === "reasoning_effort") {
              template.defaultConfiguration.thinkingLevel = value;
            }
          }
        })
        .catch(() => {});
    }

    // ACP may return refreshed configOptions in the response — reconcile
    // them the same way we do for the initial newSession.configOptions.
    if (result.configOptions && result.configOptions.length > 0) {
      await this._reconcileConfigOptions(result.configOptions, sessionId);
    }
  }

  async interrupt(): Promise<void> {
    await this.initLatch.promise;
    if (this.state.kind !== "prompting") return;
    await this.client.cancel(this.state.sessionId);
  }

  async close(): Promise<void> {
    this._terminalManager.releaseAll();
    this._unsubSessionUpdate?.();
    this._unsubSessionUpdate = null;
    this._unsubEventLog?.();
    this._unsubEventLog = null;
    // Any permission requests still waiting for a response will never
    // resolve; reject them so upstream awaiters unwind instead of
    // hanging. (Hanging would leak memory + pending-promise resources.)
    for (const [, resolve] of this._pendingPermissions) {
      resolve({ outcome: "cancelled" });
    }
    this._pendingPermissions.clear();
    await this.client.close();
    await this._setState({ kind: "closed" });
    this.initLatch.resolve();
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    for (const listener of Agent.destroyListeners) {
      listener(this.id, this.socketPath);
    }
  }
}
