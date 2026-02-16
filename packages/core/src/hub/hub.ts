import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { v7 as uuidv7 } from "uuid";
import {
  GatewayClient,
  type ConnectionState,
  type RoutedMessage,
  type SendErrorResponse,
  RequestAction,
  ResponseAction,
  StreamAction,
  type RequestPayload,
  type ResponseSuccessPayload,
  type ResponseErrorPayload,
} from "../client/index.js";
import { AsyncAgent } from "../agent/async-agent.js";
import type { AgentOptions } from "../agent/types.js";
import { getHubId } from "./hub-identity.js";
import { setHub } from "./hub-singleton.js";
import { initSubagentRegistry, shutdownSubagentRegistry } from "../agent/subagent/index.js";
import { loadAgentRecords, addAgentRecord, removeAgentRecord } from "./agent-store.js";
import { RpcDispatcher, RpcError } from "./rpc/dispatcher.js";
import { createGetAgentMessagesHandler } from "./rpc/handlers/get-agent-messages.js";
import { createGetHubInfoHandler } from "./rpc/handlers/get-hub-info.js";
import { createListAgentsHandler } from "./rpc/handlers/list-agents.js";
import { createCreateAgentHandler } from "./rpc/handlers/create-agent.js";
import { createDeleteAgentHandler } from "./rpc/handlers/delete-agent.js";
import { createUpdateGatewayHandler } from "./rpc/handlers/update-gateway.js";
import { createGetLastHeartbeatHandler } from "./rpc/handlers/get-last-heartbeat.js";
import { createSetHeartbeatsHandler } from "./rpc/handlers/set-heartbeats.js";
import { createWakeHeartbeatHandler } from "./rpc/handlers/wake-heartbeat.js";
import { DeviceStore, type DeviceMeta } from "./device-store.js";
import { createVerifyHandler } from "./rpc/handlers/verify.js";
import { createGenerateChannelWelcomeHandler } from "./rpc/handlers/generate-channel-welcome.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createResolveExecApprovalHandler } from "./rpc/handlers/resolve-exec-approval.js";
import { evaluateCommandSafety, requiresApproval } from "../agent/tools/exec-safety.js";
import { addAllowlistEntry, recordAllowlistUse, matchAllowlist } from "../agent/tools/exec-allowlist.js";
import type { ExecApprovalCallback, ExecApprovalConfig, ApprovalResult, ExecApprovalRequest } from "../agent/tools/exec-approval-types.js";
import { readProfileConfig, writeProfileConfig } from "../agent/profile/storage.js";
import { ChannelManager, initChannels } from "../channels/index.js";
import { getCronService, shutdownCronService, executeCronJob } from "../cron/index.js";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  requestHeartbeatNow,
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
  type HeartbeatEventPayload,
  type HeartbeatRunResult,
  type HeartbeatRunner,
} from "../heartbeat/index.js";
import { enqueueSystemEvent } from "../heartbeat/system-events.js";
import { isHeartbeatAckEvent } from "./heartbeat-filter.js";

// ============ Message Source Types ============

/** Message source: where did this inbound message come from? */
export type MessageSource =
  | { type: "local" }
  | { type: "gateway"; deviceId: string }
  | { type: "channel"; channelId: string; accountId: string; conversationId: string };

/** Inbound message event broadcast to all listeners */
export interface InboundMessageEvent {
  agentId: string;
  content: string;
  source: MessageSource;
  timestamp: number;
}

export class Hub {
  private readonly agents = new Map<string, AsyncAgent>();
  private readonly agentSenders = new Map<string, string>();
  private readonly agentStreamIds = new Map<string, string>();
  private readonly agentStreamCounters = new Map<string, number>();
  private readonly pendingAssistantStarts = new Map<string, { agentId: string; event: unknown }>();
  private readonly suppressedStreamAgents = new Set<string>();
  private readonly localApprovalHandlers = new Map<string, (payload: ExecApprovalRequest) => void>();
  private readonly inboundListeners = new Set<(event: InboundMessageEvent) => void>();
  private readonly rpc: RpcDispatcher;
  private readonly approvalManager: ExecApprovalManager;
  private readonly heartbeatListeners = new Set<(event: HeartbeatEventPayload) => void>();
  private heartbeatRunner: HeartbeatRunner | null = null;
  private heartbeatUnsubscribe: (() => void) | null = null;
  private client: GatewayClient;
  readonly deviceStore: DeviceStore;
  private _onConfirmDevice: ((deviceId: string, agentId: string, meta?: DeviceMeta) => Promise<boolean>) | null = null;
  private _stateChangeListeners: ((state: ConnectionState) => void)[] = [];
  readonly channelManager: ChannelManager;
  url: string;
  readonly path: string;
  readonly hubId: string;

  /** Current Gateway connection state */
  get connectionState(): ConnectionState {
    return this.client.state;
  }

  constructor(url: string, path?: string) {
    this.url = url;
    this.path = path ?? "/ws";
    this.hubId = getHubId();
    this.deviceStore = new DeviceStore();

    this.rpc = new RpcDispatcher();
    this.rpc.register("verify", createVerifyHandler({
      hubId: this.hubId,
      deviceStore: this.deviceStore,
      onConfirmDevice: (deviceId, agentId, meta) => {
        if (!this._onConfirmDevice) {
          // No UI confirm handler registered (CLI mode etc.) — auto-approve
          return Promise.resolve(true);
        }
        return this._onConfirmDevice(deviceId, agentId, meta);
      },
    }));
    this.rpc.register("generateChannelWelcome", createGenerateChannelWelcomeHandler(this));
    this.rpc.register("getAgentMessages", createGetAgentMessagesHandler());
    this.rpc.register("getHubInfo", createGetHubInfoHandler(this));
    this.rpc.register("listAgents", createListAgentsHandler(this));
    this.rpc.register("createAgent", createCreateAgentHandler(this));
    this.rpc.register("deleteAgent", createDeleteAgentHandler(this));
    this.rpc.register("updateGateway", createUpdateGatewayHandler(this));
    this.rpc.register("last-heartbeat", createGetLastHeartbeatHandler(this));
    this.rpc.register("set-heartbeats", createSetHeartbeatsHandler(this));
    this.rpc.register("wake-heartbeat", createWakeHeartbeatHandler(this));

    // Initialize exec approval manager
    this.approvalManager = new ExecApprovalManager((agentId, payload) => {
      // Check local IPC handler first (for desktop direct chat)
      const localHandler = this.localApprovalHandlers.get(agentId);
      if (localHandler) {
        localHandler(payload);
        return;
      }
      // Remote: send via Gateway
      const targetDeviceId = this.agentSenders.get(agentId);
      if (!targetDeviceId) {
        throw new Error(`No client device found for agent ${agentId}`);
      }
      this.client.send(targetDeviceId, "exec-approval-request", payload);
    });
    this.rpc.register("resolveExecApproval", createResolveExecApprovalHandler(this.approvalManager));

    // Register as global singleton for cross-module access (subagent tools, announce flow)
    setHub(this);

    // Restore subagent registry from persistent state
    initSubagentRegistry();

    // Initialize and start cron service
    this.initCronService();
    this.initHeartbeatService();

    // Initialize channel plugin system (before restoreAgents so channelManager is available)
    console.log("[Hub] Initializing channel system...");
    initChannels();
    this.channelManager = new ChannelManager(this);

    this.client = this.createClient(this.url);
    this.client.connect();
    this.restoreAgents();

    // Start channel accounts (async — bot connections happen in background)
    void this.channelManager.startAll().then(() => {
      console.log("[Hub] Channel system started");
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Hub] Channel system failed to start: ${msg}`);
    });
  }

  /** Initialize cron service with executor */
  private initCronService(): void {
    const cronService = getCronService();
    cronService.setExecutor(executeCronJob);
    cronService.start().catch((err) => {
      console.error("[Hub] Failed to start cron service:", err);
    });
    console.log("[Hub] Cron service initialized");
  }

  /** Initialize heartbeat runner + event fanout. */
  private initHeartbeatService(): void {
    this.heartbeatRunner = startHeartbeatRunner({
      getAgent: () => this.getDefaultAgent(),
      logger: console,
    });

    this.heartbeatUnsubscribe = onHeartbeatEvent((event) => {
      for (const listener of this.heartbeatListeners) {
        try {
          listener(event);
        } catch {
          // Keep fanout resilient against listener errors.
        }
      }
    });

    console.log("[Hub] Heartbeat service initialized");
  }

  private getDefaultAgent(): AsyncAgent | null {
    const first = this.listAgents()[0];
    if (!first) return null;
    return this.getAgent(first) ?? null;
  }

  /** Restore agents from persistent storage */
  private restoreAgents(): void {
    const records = loadAgentRecords();
    for (const record of records) {
      this.createAgent(record.id, { persist: false });
    }
    if (records.length > 0) {
      console.log(`[Hub] Restored ${records.length} agent(s)`);
    }
  }

  private createClient(url: string): GatewayClient {
    const client = new GatewayClient({
      url,
      path: this.path,
      deviceId: this.hubId,
      deviceType: "hub",
      autoReconnect: true,
      reconnectDelay: 1000,
    });

    client.onStateChange((state: ConnectionState) => {
      console.log(`[Hub] Connection state: ${state}`);
      for (const listener of this._stateChangeListeners) {
        listener(state);
      }
    });

    client.onRegistered((deviceId: string) => {
      console.log(`[Hub] Registered as: ${deviceId}`);
    });

    client.onError((err: Error) => {
      console.error(`[Hub] Connection error:`, err.message);
    });

    client.onMessage((msg: RoutedMessage) => {
      console.log(`[Hub] Received message: id=${msg.id} from=${msg.from} to=${msg.to} action=${msg.action} payload=${JSON.stringify(msg.payload)}`);

      // RPC request
      if (msg.action === RequestAction) {
        const payload = msg.payload as RequestPayload;
        // verify RPC is always allowed (it IS the verification step)
        if (payload.method === "verify") {
          void this.handleRpc(msg.from, payload);
          return;
        }
        // Other RPCs require verified device
        if (!this.deviceStore.isAllowed(msg.from)) {
          this.client.send<ResponseErrorPayload>(msg.from, ResponseAction, {
            requestId: payload.requestId,
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Device not verified" },
          });
          return;
        }
        void this.handleRpc(msg.from, payload);
        return;
      }

      // Non-RPC messages also require verified device
      if (!this.deviceStore.isAllowed(msg.from)) {
        console.warn(`[Hub] Rejected message from unverified device: ${msg.from}`);
        this.client.send(msg.from, "error", {
          code: "UNAUTHORIZED",
          message: "Device not verified. Please complete verification first.",
          messageId: msg.id,
        });
        return;
      }

      // Regular chat message
      const payload = msg.payload as { agentId?: string; content?: string } | undefined;
      const agentId = payload?.agentId;
      const content = payload?.content;
      if (!agentId || !content) {
        console.warn(`[Hub] Invalid payload, missing agentId or content`);
        return;
      }
      const agent = this.agents.get(agentId);
      if (agent && !agent.closed) {
        this.agentSenders.set(agentId, msg.from);
        this.channelManager.clearLastRoute();
        const source: MessageSource = { type: "gateway", deviceId: msg.from };
        this.broadcastInbound({
          agentId,
          content,
          source,
          timestamp: Date.now(),
        });
        agent.write(content, { source });
      } else {
        console.warn(`[Hub] Agent not found or closed: ${agentId}`);
      }
    });

    client.onSendError((err: SendErrorResponse) => {
      console.error(`[Hub] Send error: messageId=${err.messageId} code=${err.code} error=${err.error}`);
    });

    return client;
  }

  /** Register a confirmation handler for new device connections (called by Desktop UI) */
  setConfirmHandler(handler: ((deviceId: string, agentId: string, meta?: DeviceMeta) => Promise<boolean>) | null): void {
    this._onConfirmDevice = handler;
  }

  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onConnectionStateChange(callback: (state: ConnectionState) => void): () => void {
    this._stateChangeListeners.push(callback);
    return () => {
      const idx = this._stateChangeListeners.indexOf(callback);
      if (idx >= 0) this._stateChangeListeners.splice(idx, 1);
    };
  }

  /** Subscribe to inbound messages from all sources. Returns unsubscribe function. */
  onInboundMessage(callback: (event: InboundMessageEvent) => void): () => void {
    this.inboundListeners.add(callback);
    return () => {
      this.inboundListeners.delete(callback);
    };
  }

  /** Broadcast an inbound message to all listeners */
  broadcastInbound(event: InboundMessageEvent): void {
    for (const listener of this.inboundListeners) {
      listener(event);
    }
  }

  /** Register a one-time token for device verification (called when QR code is generated) */
  registerToken(token: string, agentId: string, expiresAt: number): void {
    this.deviceStore.registerToken(token, agentId, expiresAt);
  }

  /** 重连到新的 Gateway 地址 */
  reconnect(url: string): void {
    console.log(`[Hub] Reconnecting to ${url}`);
    this.client.disconnect();
    this.url = url;
    this.client = this.createClient(url);
    this.client.connect();
  }

  /** Register a local IPC handler for exec approval requests (desktop direct chat). */
  setLocalApprovalHandler(agentId: string, handler: (payload: ExecApprovalRequest) => void): void {
    this.localApprovalHandlers.set(agentId, handler);
  }

  /** Remove local approval handler for an agent. */
  removeLocalApprovalHandler(agentId: string): void {
    this.localApprovalHandlers.delete(agentId);
  }

  /** Resolve a pending exec approval (used by local IPC). */
  resolveExecApproval(approvalId: string, decision: "allow-once" | "allow-always" | "deny"): boolean {
    return this.approvalManager.resolveApproval(approvalId, decision);
  }

  /** Create new Agent, or rebuild with existing ID */
  createAgent(id?: string, options?: { persist?: boolean; profileId?: string }): AsyncAgent {
    if (id) {
      const existing = this.agents.get(id);
      if (existing && !existing.closed) {
        return existing;
      }
    }

    const profileId = options?.profileId ?? "default";
    const sessionId = id ?? uuidv7();
    const onExecApprovalNeeded = this.createExecApprovalCallback(sessionId, profileId);
    const onChannelSendFile = this.createChannelSendFileCallback(sessionId);
    const channels = this.channelManager.listChannelInfos();
    const agent = new AsyncAgent({ sessionId, profileId, onExecApprovalNeeded, onChannelSendFile, channels });
    this.agents.set(agent.sessionId, agent);

    // Persist to agent store (skip during restore to avoid duplicates)
    if (options?.persist !== false) {
      addAgentRecord({ id: agent.sessionId, createdAt: Date.now() });
    }

    // Internally consume agent output (AgentEvent stream + error Messages)
    void this.consumeAgent(agent);
    this.heartbeatRunner?.updateConfig();

    console.log(`Agent created: ${agent.sessionId}`);
    return agent;
  }

  private getMessageIdFromEvent(event: unknown): string | undefined {
    if (!event || typeof event !== "object") return undefined;
    const maybeMsg = (event as { message?: unknown }).message;
    if (!maybeMsg || typeof maybeMsg !== "object") return undefined;
    const id = (maybeMsg as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  private beginStream(agentId: string, event: unknown): string {
    const explicitId = this.getMessageIdFromEvent(event);
    if (explicitId) {
      this.agentStreamIds.set(agentId, explicitId);
      return explicitId;
    }
    const next = (this.agentStreamCounters.get(agentId) ?? 0) + 1;
    this.agentStreamCounters.set(agentId, next);
    const fallback = `${agentId}:${next}`;
    this.agentStreamIds.set(agentId, fallback);
    return fallback;
  }

  private getActiveStreamId(agentId: string, event: unknown): string {
    return this.agentStreamIds.get(agentId) ?? this.getMessageIdFromEvent(event) ?? agentId;
  }

  private endStream(agentId: string): void {
    this.agentStreamIds.delete(agentId);
  }

  private clearPendingAssistantStarts(agentId: string): void {
    for (const [streamId, pending] of this.pendingAssistantStarts) {
      if (pending.agentId === agentId) {
        this.pendingAssistantStarts.delete(streamId);
      }
    }
  }

  /** Internally read agent output and send via Gateway */
  private async consumeAgent(agent: AsyncAgent): Promise<void> {
    for await (const item of agent.read()) {
      const targetDeviceId = this.agentSenders.get(agent.sessionId);
      if (!targetDeviceId) continue;

      if ("content" in item) {
        // Legacy Message (error fallback)
        console.log(`[${agent.sessionId}] ${item.content}`);
        this.client.send(targetDeviceId, "message", {
          agentId: agent.sessionId,
          content: item.content,
        });
      } else {
        const suppressForAgent = this.suppressedStreamAgents.has(agent.sessionId);

        // Suppress all user-visible stream events during silent heartbeat runs.
        if (suppressForAgent) {
          if (item.type === "message_start") {
            this.beginStream(agent.sessionId, item);
          } else if (item.type === "message_end") {
            const streamId = this.getActiveStreamId(agent.sessionId, item);
            this.pendingAssistantStarts.delete(streamId);
            this.endStream(agent.sessionId);
          }
          continue;
        }

        // Passthrough events: forward with synthetic streamId (no stream tracking)
        const isPassthroughEvent =
          item.type === "compaction_start" || item.type === "compaction_end" || item.type === "agent_error";
        if (isPassthroughEvent) {
          this.client.send(targetDeviceId, StreamAction, {
            streamId: `system:${agent.sessionId}`,
            agentId: agent.sessionId,
            event: item,
          });
          continue;
        }

        // Filter: only forward events useful for frontend rendering
        const maybeMessage = (item as { message?: { role?: string } }).message;
        const isAssistantMessage = maybeMessage?.role === "assistant";
        const shouldForward =
          ((item.type === "message_start" || item.type === "message_update" || item.type === "message_end") && isAssistantMessage)
          || item.type === "tool_execution_start"
          || item.type === "tool_execution_end";
        if (!shouldForward) continue;

        const isAssistantMessageEvent =
          item.type === "message_start" || item.type === "message_update" || item.type === "message_end";

        // Delay assistant message_start forwarding until we see content.
        // This lets us suppress pure HEARTBEAT_OK acknowledgements end-to-end.
        if (isAssistantMessageEvent && isAssistantMessage) {
          if (item.type === "message_start") {
            const streamId = this.beginStream(agent.sessionId, item);
            this.pendingAssistantStarts.set(streamId, { agentId: agent.sessionId, event: item });
            continue;
          }

          const streamId = this.getActiveStreamId(agent.sessionId, item);
          const isHeartbeatAck = isHeartbeatAckEvent(item);
          if (isHeartbeatAck) {
            if (item.type === "message_end") {
              this.pendingAssistantStarts.delete(streamId);
              this.endStream(agent.sessionId);
            }
            continue;
          }

          const pendingStart = this.pendingAssistantStarts.get(streamId);
          if (pendingStart) {
            this.client.send(targetDeviceId, StreamAction, {
              streamId,
              agentId: agent.sessionId,
              event: pendingStart.event,
            });
            this.pendingAssistantStarts.delete(streamId);
          }

          this.client.send(targetDeviceId, StreamAction, {
            streamId,
            agentId: agent.sessionId,
            event: item,
          });
          if (item.type === "message_end") {
            this.endStream(agent.sessionId);
          }
          continue;
        }

        const streamId = this.getActiveStreamId(agent.sessionId, item);
        this.client.send(targetDeviceId, StreamAction, {
          streamId,
          agentId: agent.sessionId,
          event: item,
        });
      }
    }
  }

  /** Handle RPC request and send response back via Gateway */
  private async handleRpc(from: string, request: RequestPayload): Promise<void> {
    const { requestId, method } = request;
    try {
      const result = await this.rpc.dispatch(method, request.params, from);
      this.client.send<ResponseSuccessPayload>(from, ResponseAction, {
        requestId,
        ok: true,
        payload: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : "RPC_ERROR";
      console.error(`[Hub] RPC error: method=${method} code=${code} error=${message}`);
      this.client.send<ResponseErrorPayload>(from, ResponseAction, {
        requestId,
        ok: false,
        error: { code, message },
      });
    }
  }

  /** Create a subagent with specific options (isSubagent, systemPrompt, model) */
  createSubagent(sessionId: string, options: Omit<AgentOptions, "sessionId"> = {}): AsyncAgent {
    const existing = this.agents.get(sessionId);
    if (existing && !existing.closed) {
      return existing;
    }

    const agent = new AsyncAgent({
      ...options,
      sessionId,
      isSubagent: true,
    });
    this.agents.set(agent.sessionId, agent);

    // Subagents are ephemeral — don't persist to agent store
    void this.consumeAgent(agent);

    console.log(`[Hub] Subagent created: ${agent.sessionId}`);
    return agent;
  }

  /**
   * Create an exec approval callback for an agent.
   * This wires the safety evaluation + Hub approval manager together.
   */
  private createExecApprovalCallback(sessionId: string, profileId: string): ExecApprovalCallback {
    return async (command: string, cwd: string | undefined): Promise<ApprovalResult> => {
      // Load exec approval config from profile
      let config: ExecApprovalConfig = {};
      try {
        const profileConfig = readProfileConfig(profileId);
        config = profileConfig?.execApproval ?? {};
      } catch {
        // No profile config, use defaults
      }

      const security = config.security ?? "full";
      const ask = config.ask ?? "off";

      // Security: deny blocks everything
      if (security === "deny") {
        return { approved: false, decision: "deny" };
      }

      // Security: full allows everything
      if (security === "full") {
        return { approved: true, decision: "allow-once" };
      }

      // Evaluate safety
      const evaluation = evaluateCommandSafety(command, config);

      // Check if approval is needed
      const needsApproval = requiresApproval({
        ask,
        security,
        analysisOk: evaluation.analysisOk,
        allowlistSatisfied: evaluation.allowlistSatisfied,
      });

      if (!needsApproval) {
        // Record allowlist usage
        if (evaluation.allowlistSatisfied) {
          const match = matchAllowlist(config.allowlist ?? [], command);
          if (match) {
            try {
              const profileConfig = readProfileConfig(profileId) ?? {};
              const updated = recordAllowlistUse(profileConfig.execApproval?.allowlist ?? [], match, command);
              writeProfileConfig(profileId, { ...profileConfig, execApproval: { ...config, allowlist: updated } });
            } catch {
              // Non-critical: don't fail command for usage recording
            }
          }
        }
        return { approved: true, decision: "allow-once" };
      }

      // Request approval via Hub → Gateway → Client
      const result = await this.approvalManager.requestApproval({
        agentId: sessionId,
        command,
        ...(cwd !== undefined ? { cwd } : {}),
        riskLevel: evaluation.riskLevel,
        riskReasons: evaluation.reasons,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.askFallback !== undefined ? { askFallback: config.askFallback } : {}),
        ...(evaluation.allowlistSatisfied !== undefined ? { allowlistSatisfied: evaluation.allowlistSatisfied } : {}),
      });

      // Handle allow-always: persist to profile allowlist
      if (result.decision === "allow-always") {
        try {
          const profileConfig = readProfileConfig(profileId) ?? {};
          const currentAllowlist = profileConfig.execApproval?.allowlist ?? [];
          // Extract binary pattern for allowlist
          const binary = command.trim().split(/\s+/)[0];
          const pattern = binary ? `${binary} **` : command;
          const updated = addAllowlistEntry(currentAllowlist, pattern);
          writeProfileConfig(profileId, {
            ...profileConfig,
            execApproval: { ...config, allowlist: updated },
          });
        } catch {
          // Non-critical: command still allowed even if persistence fails
        }
      }

      return result;
    };
  }

  /**
   * Create a callback for the send_file tool that routes files through
   * the channel plugin (local) or gateway (remote) path.
   */
  private createChannelSendFileCallback(sessionId: string): (filePath: string, caption: string | undefined, type: string) => Promise<boolean> {
    return async (filePath: string, caption: string | undefined, type: string): Promise<boolean> => {
      // Path 1: Channel plugin (local bot — file on same machine)
      const sentViaChannel = await this.channelManager.sendFile(filePath, caption, type);
      if (sentViaChannel) return true;

      // Path 2: Gateway (remote bot — read file, base64 encode, send via RoutedMessage)
      const deviceId = this.agentSenders.get(sessionId);
      if (deviceId) {
        try {
          const fileBuffer = await readFile(filePath);
          this.client.send(deviceId, "send_file", {
            data: fileBuffer.toString("base64"),
            type,
            caption,
            filename: basename(filePath),
          });
          console.log(`[Hub] Sent file via gateway: ${basename(filePath)} → ${deviceId}`);
          return true;
        } catch (err) {
          console.error(`[Hub] Failed to send file via gateway: ${err}`);
          return false;
        }
      }

      return false;
    };
  }

  getAgent(id: string): AsyncAgent | undefined {
    return this.agents.get(id);
  }

  listAgents(): string[] {
    return Array.from(this.agents.entries())
      .filter(([, a]) => !a.closed)
      .map(([id]) => id);
  }

  /** Subscribe heartbeat state updates. Returns unsubscribe callback. */
  onHeartbeatEvent(callback: (event: HeartbeatEventPayload) => void): () => void {
    this.heartbeatListeners.add(callback);
    return () => {
      this.heartbeatListeners.delete(callback);
    };
  }

  /** Get latest heartbeat event payload. */
  getLastHeartbeat(): HeartbeatEventPayload | null {
    return getLastHeartbeatEvent();
  }

  /** Enable/disable heartbeat runner globally. */
  setHeartbeatsEnabled(enabled: boolean): void {
    setHeartbeatsEnabled(enabled);
    this.heartbeatRunner?.updateConfig();
  }

  /** Enqueue a heartbeat wake request. */
  requestHeartbeatNow(opts?: { reason?: string }): void {
    requestHeartbeatNow(opts);
  }

  /** Run heartbeat immediately using the current default agent. */
  async runHeartbeatOnce(opts?: { reason?: string }): Promise<HeartbeatRunResult> {
    const agent = this.getDefaultAgent();
    const reason = opts?.reason;
    const shouldSuppressStreams = reason === "manual";
    if (shouldSuppressStreams && agent) {
      this.suppressedStreamAgents.add(agent.sessionId);
    }

    try {
      if (reason) {
        return runHeartbeatOnce({
          agent,
          reason,
        });
      }
      return runHeartbeatOnce({
        agent,
      });
    } finally {
      if (shouldSuppressStreams && agent) {
        this.suppressedStreamAgents.delete(agent.sessionId);
      }
    }
  }

  /** Enqueue a system event for a specific agent or the default agent. */
  enqueueSystemEvent(text: string, opts?: { agentId?: string }): void {
    const agentId = opts?.agentId ?? this.listAgents()[0];
    if (!agentId) return;
    enqueueSystemEvent(text, { sessionKey: agentId });
  }

  closeAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.close();
    this.approvalManager.cancelPending(id);
    this.agents.delete(id);
    this.agentSenders.delete(id);
    this.agentStreamIds.delete(id);
    this.agentStreamCounters.delete(id);
    this.clearPendingAssistantStarts(id);
    this.suppressedStreamAgents.delete(id);
    this.localApprovalHandlers.delete(id);
    removeAgentRecord(id);
    this.heartbeatRunner?.updateConfig();
    return true;
  }

  shutdown(): void {
    // Stop all channel connections
    this.channelManager.stopAll();

    // Stop cron service
    shutdownCronService();
    this.heartbeatRunner?.stop();
    this.heartbeatRunner = null;
    this.heartbeatUnsubscribe?.();
    this.heartbeatUnsubscribe = null;
    this.heartbeatListeners.clear();

    // Finalize subagent registry before closing agents
    shutdownSubagentRegistry();

    for (const [id, agent] of this.agents) {
      agent.close();
      this.agents.delete(id);
      this.agentSenders.delete(id);
      this.agentStreamIds.delete(id);
      this.agentStreamCounters.delete(id);
      this.clearPendingAssistantStarts(id);
      this.suppressedStreamAgents.delete(id);
      this.localApprovalHandlers.delete(id);
    }
    this.client.disconnect();
    console.log("Hub shut down");
  }
}
