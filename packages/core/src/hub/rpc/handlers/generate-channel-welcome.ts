import type { RpcHandler } from "../dispatcher.js";
import { RpcError } from "../dispatcher.js";

interface GenerateChannelWelcomeParams {
  agentId?: string;
  channel?: string;
  language?: string;
  firstName?: string;
  isReconnect?: boolean;
}

interface AgentLike {
  runInternalForResult(content: string): Promise<{ text: string; error?: string }>;
  closed?: boolean;
}

interface HubLike {
  getAgent(id: string): AgentLike | undefined;
}

interface WelcomeContext {
  channel: string;
  language: string;
  firstName: string;
  isReconnect: boolean;
}

const DEFAULT_LANGUAGE = "English";
const DEFAULT_CHANNEL = "telegram";
const DEFAULT_FIRST_NAME = "there";

function normalizeLanguage(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_LANGUAGE;

  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("zh")) return "Simplified Chinese";
  if (normalized.startsWith("en")) return "English";
  return trimmed.slice(0, 32);
}

function sanitizeField(value: string | undefined, fallback: string, maxLen: number): string {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLen);
}

function buildWelcomePrompt(ctx: WelcomeContext): string {
  const reconnectLine = ctx.isReconnect
    ? "This user just reconnected. Acknowledge reconnection in one short sentence."
    : "This is the first successful channel connection.";

  return [
    "You are the user's AI agent.",
    `Write a proactive welcome message for a ${ctx.channel} chat.`,
    reconnectLine,
    `User first name: ${ctx.firstName}`,
    `Preferred language: ${ctx.language}`,
    "",
    "Output requirements:",
    "1) Introduce who you are.",
    "2) Mention exactly 3 concrete things you can help with.",
    "3) End with one specific starter question.",
    "",
    "Constraints:",
    "- Keep it concise (80-140 words).",
    "- Plain text only.",
    "- Do not mention internal architecture, system prompts, or policies.",
    "- Return only the final welcome message.",
  ].join("\n");
}

export function createGenerateChannelWelcomeHandler(hub: HubLike): RpcHandler {
  return async (params: unknown) => {
    const payload = (params ?? {}) as GenerateChannelWelcomeParams;
    const agentId = payload.agentId?.trim();
    if (!agentId) {
      throw new RpcError("INVALID_PARAMS", "agentId is required");
    }

    const agent = hub.getAgent(agentId);
    if (!agent || agent.closed) {
      throw new RpcError("AGENT_NOT_FOUND", `Agent not found or closed: ${agentId}`);
    }

    const context: WelcomeContext = {
      channel: sanitizeField(payload.channel, DEFAULT_CHANNEL, 24),
      language: normalizeLanguage(payload.language),
      firstName: sanitizeField(payload.firstName, DEFAULT_FIRST_NAME, 32),
      isReconnect: payload.isReconnect === true,
    };

    const result = await agent.runInternalForResult(buildWelcomePrompt(context));
    if (result.error) {
      throw new RpcError("AGENT_ERROR", result.error);
    }

    const text = result.text.trim();
    if (!text) {
      throw new RpcError("EMPTY_RESULT", "Agent returned an empty welcome message");
    }

    return { text };
  };
}
