/**
 * Telegram service for Gateway.
 *
 * Handles Telegram bot interactions via webhook or long-polling.
 * - Webhook mode: when TELEGRAM_WEBHOOK_URL is set (production / ngrok)
 * - Long-polling mode: when TELEGRAM_WEBHOOK_URL is NOT set (local development)
 *
 * - New users: prompts to paste a multica://connect link
 * - Connection link: verifies with Hub via RPC, persists to DB
 * - Bound users: routes messages to their Hub agent
 *
 * Features (ported from Desktop channel plugin):
 * - Markdown → Telegram HTML formatting with parse-error fallback
 * - Text chunking for messages >4096 chars (paragraph-boundary split)
 * - Reply-to original message + 👀 ack reaction
 * - Per-chat message serialization (prevents race conditions)
 * - Inbound media handling (voice, photo, video, document)
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Bot, GrammyError, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import type { Context } from "grammy";
import { v7 as uuidv7 } from "uuid";
import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { generateEncryptedId, MEDIA_CACHE_DIR } from "@multica/utils";
import { parseConnectionCode } from "@multica/store/connection";
import type { ConnectionInfo } from "@multica/store/connection";
import { transcribeAudio, describeImage, describeVideo } from "@multica/core/media";
import {
  GatewayEvents,
  RequestAction,
  ResponseAction,
  StreamAction,
  type RoutedMessage,
  type RequestPayload,
  type ResponsePayload,
  type VerifyParams,
  type VerifyResult,
  type DeviceMeta,
} from "@multica/sdk";
import type { StreamPayload } from "@multica/sdk";
import { EventsGateway } from "../events.gateway.js";
import { TelegramUserStore } from "./telegram-user.store.js";
import type { TelegramUser } from "./types.js";
import { markdownToTelegramHtml } from "./telegram-format.js";
import { ShortCodeStore } from "./short-code-store.js";

// ── Types ──

/** Minimal Express types for webhook handling */
interface ExpressRequest {
  body: unknown;
  header: (name: string) => string | undefined;
}

interface ExpressResponse {
  status: (code: number) => ExpressResponse;
  json: (data: unknown) => void;
  headersSent: boolean;
}

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Tracks the originating Telegram message for reply_to and reaction cleanup */
interface MessageContext {
  telegramChatId: number;
  telegramMessageId: number;
}

/** Media attachment extracted from a Telegram message */
interface MediaAttachment {
  type: "audio" | "image" | "video" | "document";
  fileId: string;
  mimeType?: string;
  duration?: number;
  caption?: string;
}

interface GenerateChannelWelcomeParams {
  agentId: string;
  channel: string;
  language?: string;
  firstName?: string;
  isReconnect?: boolean;
}

interface GenerateChannelWelcomeResult {
  text: string;
}

// ── Constants ──

const VERIFY_TIMEOUT_MS = 30_000;
const WELCOME_RPC_TIMEOUT_MS = 20_000;
const WELCOME_COOLDOWN_MS = 15_000;
const TYPING_TIMEOUT_MS = 60_000;
const MAX_CHARS_PER_MESSAGE = 4000; // Telegram limit is 4096; leave room for HTML overhead
const REPLY_CONTEXT_MAX_CHARS = 300; // Max chars of quoted text when user replies to a message

// ── Callback data identifiers ──

const CB_HOW_TO_CONNECT = "onboard:how";
const CB_WHAT_IS_MULTICA = "onboard:what";
const CB_CHECK_STATUS = "action:status";
const CB_SHOW_HELP = "action:help";
const CB_RECONNECT = "action:reconnect";

// ── Helpers ──

/** Check if a GrammyError is an HTML parse failure */
function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes("can't parse entities");
}

/**
 * Extract reply context when a user replies to a specific message in Telegram.
 * Returns a formatted annotation like `[Replying to: "original text..."]` or null.
 */
function extractReplyContext(ctx: Context): string | null {
  const replyMsg = ctx.message?.reply_to_message;
  if (!replyMsg) return null;

  const text = replyMsg.text || replyMsg.caption;
  if (!text) return null;

  const truncated = text.length > REPLY_CONTEXT_MAX_CHARS
    ? text.slice(0, REPLY_CONTEXT_MAX_CHARS) + "..."
    : text;
  return `[Replying to: "${truncated}"]`;
}

/**
 * Split text at natural boundaries so each chunk stays within Telegram's message limit.
 * Prefers paragraph breaks > line breaks > spaces > hard cut.
 */
function chunkText(text: string, maxChars = MAX_CHARS_PER_MESSAGE): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find the best break point within the limit
    let breakPoint = remaining.lastIndexOf("\n\n", maxChars);
    if (breakPoint <= 0 || breakPoint < maxChars * 0.5) {
      breakPoint = remaining.lastIndexOf("\n", maxChars);
    }
    if (breakPoint <= 0 || breakPoint < maxChars * 0.5) {
      breakPoint = remaining.lastIndexOf(" ", maxChars);
    }
    if (breakPoint <= 0) {
      breakPoint = maxChars;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

// ── Service ──

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot | null = null;
  private pollingMode = false;
  private botUsername: string | null = null;
  private readonly shortCodeStore = new ShortCodeStore();

  private pendingRequests = new Map<string, PendingRequest>();
  /** Typing indicator timers, keyed by deviceId */
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Tracks the originating message for reply_to & reaction cleanup, keyed by deviceId */
  private messageContexts = new Map<string, MessageContext>();
  /** Deduplicate welcome sends when Telegram replays updates in a short window */
  private welcomeSentAt = new Map<string, number>();

  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
    @Inject(TelegramUserStore) private readonly userStore: TelegramUserStore,
  ) {}

  // ── Lifecycle ──

  async onModuleInit(): Promise<void> {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) {
      this.logger.warn("TELEGRAM_BOT_TOKEN not set, Telegram disabled");
      return;
    }

    this.bot = new Bot(token);

    // Fetch bot info (username) before setting up handlers
    try {
      const me = await this.bot.api.getMe();
      this.botUsername = me.username ?? null;
      this.logger.log(`Telegram bot: @${this.botUsername}`);
    } catch (err) {
      this.logger.warn(`Failed to fetch bot info: ${err instanceof Error ? err.message : err}`);
    }

    this.setupHandlers();
    await this.setupBotCommands();

    const webhookUrl = process.env["TELEGRAM_WEBHOOK_URL"];
    if (webhookUrl) {
      // Webhook mode — Telegram sends updates to our /telegram/webhook endpoint
      this.logger.log(`Telegram bot initialized (webhook mode: ${webhookUrl})`);
    } else {
      // Long-polling mode — pull updates from Telegram (local development)
      this.pollingMode = true;
      this.bot
        .start({
          onStart: () => {
            this.logger.log("Telegram bot initialized (long-polling mode)");
          },
        })
        .catch((err) => {
          if (err instanceof GrammyError && err.error_code === 409) {
            this.logger.warn(
              "Telegram bot polling conflict (409): another instance is already running. Polling stopped.",
            );
          } else {
            this.logger.error(`Telegram bot polling error: ${err instanceof Error ? err.message : err}`);
          }
          this.pollingMode = false;
        });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shortCodeStore.destroy();
    if (this.bot && this.pollingMode) {
      await this.bot.stop();
      this.logger.log("Telegram bot stopped");
    }
  }

  /** Get grammY webhook callback for Express/NestJS */
  getWebhookCallback(): ((req: ExpressRequest, res: ExpressResponse) => Promise<void>) | null {
    if (!this.bot) return null;

    const secretToken = process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
    if (secretToken) {
      return webhookCallback(this.bot, "express", { secretToken }) as unknown as (
        req: ExpressRequest,
        res: ExpressResponse,
      ) => Promise<void>;
    }
    return webhookCallback(this.bot, "express") as unknown as (
      req: ExpressRequest,
      res: ExpressResponse,
    ) => Promise<void>;
  }

  /** Check if Telegram bot is configured */
  isConfigured(): boolean {
    return this.bot !== null;
  }

  /** Get the bot's Telegram username (e.g. "multica_bot") */
  getBotUsername(): string | null {
    return this.botUsername;
  }

  /** Create a short code for a connection info (for Telegram deep link QR flow) */
  createConnectCode(connectionInfo: ConnectionInfo): string {
    return this.shortCodeStore.store(connectionInfo);
  }

  // ── Handler setup ──

  private setupHandlers(): void {
    if (!this.bot) return;

    // Global error boundary — catches unhandled errors from all middleware/handlers
    // so they don't crash the polling loop or propagate as unhandled rejections.
    this.bot.catch((err) => {
      this.logger.error(`Unhandled bot error: ${err.message}`);
    });

    // Per-chat serialization middleware — ensures messages from the same chat
    // are processed one at a time, preventing race conditions.
    const chatQueues = new Map<string, Promise<void>>();
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return next();

      const key = String(chatId);
      const prev = chatQueues.get(key) ?? Promise.resolve();

      const current = prev.then(() => next()).catch(() => {});
      chatQueues.set(key, current);
      await current;

      // Clean up resolved entries to prevent memory leak
      if (chatQueues.get(key) === current) {
        chatQueues.delete(key);
      }
    });

    // Bot commands (must be registered before message:text)
    this.bot.command("start", async (ctx) => {
      if (!this.isPrivateChat(ctx)) return;
      const payload = ctx.match?.trim();
      if (payload) {
        // Deep link: /start <short_code>
        await this.handleShortCode(ctx, String(ctx.from?.id), payload);
        return;
      }

      const telegramUserId = String(ctx.from?.id);
      const user = await this.userStore.findByTelegramUserId(telegramUserId);

      if (user) {
        const online = this.eventsGateway.isDeviceRegistered(user.hubId);
        const { text, keyboard } = this.buildConnectedWelcome(user, online);
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      } else {
        const { text, keyboard } = this.buildWelcomeMessage();
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    });

    this.bot.command("status", async (ctx) => {
      if (!this.isPrivateChat(ctx)) return;
      const telegramUserId = String(ctx.from?.id);
      const user = await this.userStore.findByTelegramUserId(telegramUserId);
      const online = user ? this.eventsGateway.isDeviceRegistered(user.hubId) : false;
      const { text, keyboard } = this.buildStatusMessage(user, online);
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    this.bot.command("help", async (ctx) => {
      if (!this.isPrivateChat(ctx)) return;
      const telegramUserId = String(ctx.from?.id);
      const user = await this.userStore.findByTelegramUserId(telegramUserId);
      const { text, keyboard } = this.buildHelpMessage(!!user);
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // Inline button callback queries
    this.bot.callbackQuery(CB_HOW_TO_CONNECT, async (ctx) => {
      await ctx.answerCallbackQuery();
      const { text, keyboard } = this.buildConnectionGuide();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    this.bot.callbackQuery(CB_WHAT_IS_MULTICA, async (ctx) => {
      await ctx.answerCallbackQuery();
      const { text, keyboard } = this.buildWhatIsMultica();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    this.bot.callbackQuery(CB_CHECK_STATUS, async (ctx) => {
      await ctx.answerCallbackQuery();
      const telegramUserId = String(ctx.from?.id);
      const user = await this.userStore.findByTelegramUserId(telegramUserId);
      const online = user ? this.eventsGateway.isDeviceRegistered(user.hubId) : false;
      const { text, keyboard } = this.buildStatusMessage(user, online);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        // editMessageText throws if content is unchanged (rapid refresh)
      }
    });

    this.bot.callbackQuery(CB_SHOW_HELP, async (ctx) => {
      await ctx.answerCallbackQuery();
      const telegramUserId = String(ctx.from?.id);
      const user = await this.userStore.findByTelegramUserId(telegramUserId);
      const { text, keyboard } = this.buildHelpMessage(!!user);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    this.bot.callbackQuery(CB_RECONNECT, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Scan a new QR code from Desktop to reconnect." });
      const { text, keyboard } = this.buildConnectionGuide();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // Text messages (private chats only)
    this.bot.on("message:text", async (ctx) => {
      if (!this.isPrivateChat(ctx)) return;
      await this.handleTextMessage(ctx);
    });

    // Media messages
    const mediaTypes = [
      {
        filter: "message:voice" as const,
        getMedia: (msg: any): MediaAttachment => ({
          type: "audio" as const,
          fileId: msg.voice.file_id as string,
          mimeType: msg.voice.mime_type as string | undefined,
          duration: msg.voice.duration as number | undefined,
        }),
      },
      {
        filter: "message:audio" as const,
        getMedia: (msg: any): MediaAttachment => ({
          type: "audio" as const,
          fileId: msg.audio.file_id as string,
          mimeType: msg.audio.mime_type as string | undefined,
          duration: msg.audio.duration as number | undefined,
        }),
      },
      {
        filter: "message:photo" as const,
        getMedia: (msg: any): MediaAttachment => {
          // Pick the largest photo size (last in array)
          const photos = msg.photo as Array<{ file_id: string }>;
          const largest = photos[photos.length - 1]!;
          return {
            type: "image" as const,
            fileId: largest.file_id,
            mimeType: "image/jpeg",
          };
        },
      },
      {
        filter: "message:video" as const,
        getMedia: (msg: any): MediaAttachment => ({
          type: "video" as const,
          fileId: msg.video.file_id as string,
          mimeType: msg.video.mime_type as string | undefined,
          duration: msg.video.duration as number | undefined,
        }),
      },
      {
        filter: "message:document" as const,
        getMedia: (msg: any): MediaAttachment => ({
          type: "document" as const,
          fileId: msg.document.file_id as string,
          mimeType: msg.document.mime_type as string | undefined,
        }),
      },
    ] as const;

    for (const { filter, getMedia } of mediaTypes) {
      this.bot.on(filter, async (ctx) => {
        if (!this.isPrivateChat(ctx)) return;
        await this.handleMediaMessage(ctx, getMedia(ctx.message));
      });
    }
  }

  /** Only process private (direct) messages; silently ignore group chats. */
  private isPrivateChat(ctx: Context): boolean {
    return ctx.chat?.type === "private";
  }

  // ── Message builders ──

  private buildWelcomeMessage(): { text: string; keyboard: InlineKeyboard } {
    const text =
      `<b>Welcome to Multica</b>\n\n` +
      `Multica connects your AI agent to Telegram so you can chat with it from anywhere.\n\n` +
      `To get started, connect your Multica Desktop app to this bot. ` +
      `Tap the button below for step-by-step instructions.`;

    const keyboard = new InlineKeyboard()
      .text("How to connect", CB_HOW_TO_CONNECT)
      .row()
      .text("What is Multica?", CB_WHAT_IS_MULTICA);

    return { text, keyboard };
  }

  private buildConnectionGuide(): { text: string; keyboard: InlineKeyboard } {
    const text =
      `<b>How to Connect</b>\n\n` +
      `Follow these steps:\n\n` +
      `<b>1.</b>  Open the <b>Multica Desktop</b> app\n` +
      `<b>2.</b>  Go to <b>Clients</b> \u2192 <b>Channels</b>\n` +
      `<b>3.</b>  Click the <b>Telegram</b> channel\n` +
      `<b>4.</b>  Scan the <b>QR code</b> with your phone camera\n` +
      `       <i>(this opens a deep link that connects automatically)</i>\n\n` +
      `<b>Alternative:</b> Copy the connection link from Desktop and paste it here. ` +
      `The link looks like:\n` +
      `<code>multica://connect?gateway=...&amp;hub=...&amp;token=...</code>`;

    const keyboard = new InlineKeyboard()
      .text("Check connection status", CB_CHECK_STATUS);

    return { text, keyboard };
  }

  private buildWhatIsMultica(): { text: string; keyboard: InlineKeyboard } {
    const text =
      `<b>What is Multica?</b>\n\n` +
      `Multica is an AI agent framework that runs on your desktop. ` +
      `It connects to multiple LLM providers (OpenAI, Anthropic, Google, and more) ` +
      `and gives you a personal AI assistant with skills, tools, and memory.\n\n` +
      `This Telegram bot acts as a remote channel: once connected, ` +
      `every message you send here goes to your agent, and every response comes back.\n\n` +
      `<b>Features:</b>\n` +
      `  \u2022 Voice messages (auto-transcribed)\n` +
      `  \u2022 Image and video understanding\n` +
      `  \u2022 File sharing\n` +
      `  \u2022 Rich formatted responses`;

    const keyboard = new InlineKeyboard()
      .text("How to connect", CB_HOW_TO_CONNECT);

    return { text, keyboard };
  }

  private buildConnectedWelcome(user: TelegramUser, online: boolean): { text: string; keyboard: InlineKeyboard } {
    const statusEmoji = online ? "\u2705" : "\u26a0\ufe0f";
    const statusText = online ? "Online" : "Offline";

    const text =
      `<b>Welcome back!</b>\n\n` +
      `${statusEmoji} Status: <b>${statusText}</b>\n` +
      `Agent: <code>${user.agentId}</code>\n\n` +
      (online
        ? `Your agent is ready. Just send a message to start chatting.`
        : `Your Hub is offline. Make sure the Multica Desktop app is running.`);

    const keyboard = new InlineKeyboard()
      .text("Check status", CB_CHECK_STATUS)
      .text("Help", CB_SHOW_HELP)
      .row()
      .text("Reconnect", CB_RECONNECT);

    return { text, keyboard };
  }

  private buildStatusMessage(user: TelegramUser | null, online: boolean): { text: string; keyboard: InlineKeyboard } {
    if (!user) {
      const text =
        `<b>Connection Status</b>\n\n` +
        `\u274c <b>Not connected</b>\n\n` +
        `You haven't linked a Multica account yet.`;

      const keyboard = new InlineKeyboard()
        .text("How to connect", CB_HOW_TO_CONNECT);

      return { text, keyboard };
    }

    const statusEmoji = online ? "\u2705" : "\u26a0\ufe0f";
    const statusLabel = online ? "Online" : "Offline";

    const text =
      `<b>Connection Status</b>\n\n` +
      `${statusEmoji} <b>${statusLabel}</b>\n\n` +
      `Hub: <code>${user.hubId}</code>\n` +
      `Agent: <code>${user.agentId}</code>\n\n` +
      (online
        ? `Your Hub is online and ready to receive messages.`
        : `Your Hub is offline. Make sure the Multica Desktop app is running.`);

    const keyboard = new InlineKeyboard()
      .text("Refresh", CB_CHECK_STATUS)
      .text("Help", CB_SHOW_HELP);

    if (!online) {
      keyboard.row().text("Reconnect", CB_RECONNECT);
    }

    return { text, keyboard };
  }

  private buildHelpMessage(isConnected: boolean): { text: string; keyboard: InlineKeyboard } {
    const text =
      `<b>Multica Telegram Bot</b>\n\n` +
      `<b>Commands</b>\n` +
      `  /start \u2014 Connect your account or see welcome\n` +
      `  /status \u2014 Check connection status\n` +
      `  /help \u2014 Show this message\n\n` +
      `<b>How to connect</b>\n` +
      `  <b>1.</b> Open Multica Desktop app\n` +
      `  <b>2.</b> Go to <b>Clients</b> \u2192 <b>Channels</b>\n` +
      `  <b>3.</b> Scan the Telegram QR code\n\n` +
      `<b>What you can send</b>\n` +
      `  \u2022 Text messages\n` +
      `  \u2022 Voice messages (auto-transcribed)\n` +
      `  \u2022 Photos and videos (auto-described)\n` +
      `  \u2022 Documents`;

    const keyboard = isConnected
      ? new InlineKeyboard().text("Check status", CB_CHECK_STATUS)
      : new InlineKeyboard().text("How to connect", CB_HOW_TO_CONNECT);

    return { text, keyboard };
  }

  /** Register bot commands with Telegram (shown in the menu) */
  private async setupBotCommands(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "Connect or show welcome" },
        { command: "status", description: "Check connection status" },
        { command: "help", description: "Show help and instructions" },
      ]);

      // Set menu button to open the commands list
      await this.bot.api.setChatMenuButton({
        menu_button: { type: "commands" },
      });

      this.logger.log("Telegram bot commands and menu button registered");
    } catch (err) {
      this.logger.warn(`Failed to set bot commands: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Handle a short code from /start deep link */
  private async handleShortCode(ctx: Context, telegramUserId: string, code: string): Promise<void> {
    const connectionInfo = this.shortCodeStore.consume(code);
    if (!connectionInfo) {
      await ctx.reply(
        `<b>\u26a0\ufe0f Connection code expired or invalid</b>\n\n` +
          `QR codes are valid for 30 seconds. Please scan again from the Desktop app.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    await this.connectUser(ctx, telegramUserId, connectionInfo);
  }

  // ── Inbound: text messages ──

  private async handleTextMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !msg.text) return;

    const telegramUserId = String(msg.from?.id);
    const text = msg.text.trim();

    this.logger.debug(`Received message: chatId=${msg.chat.id} from=${telegramUserId} text="${text.slice(0, 50)}"`);

    // Connection link — always handle, even for already-bound users (re-binding)
    if (text.startsWith("multica://connect?")) {
      await this.handleConnectionLink(ctx, telegramUserId, text);
      return;
    }

    if (!text) return;

    // Check if user is bound
    const user = await this.userStore.findByTelegramUserId(telegramUserId);

    if (user) {
      // ACK: 👀 reaction on the original message
      await this.addReaction(msg.chat.id, msg.message_id, "👀");
      this.storeMessageContext(user.deviceId, msg.chat.id, msg.message_id);
      // Prepend reply context if user is replying to a specific message
      const replyContext = extractReplyContext(ctx);
      const content = replyContext ? `${replyContext}\n${text}` : text;
      await this.routeToHub(user, content, ctx);
      return;
    }

    // New user without connection link
    const welcome = this.buildWelcomeMessage();
    await ctx.reply(welcome.text, { parse_mode: "HTML", reply_markup: welcome.keyboard });
  }

  // ── Inbound: media messages ──

  private async handleMediaMessage(ctx: Context, media: MediaAttachment): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const telegramUserId = String(msg.from?.id);
    const caption = (msg as any).caption as string | undefined;

    this.logger.debug(`Received ${media.type}: chatId=${msg.chat.id} from=${telegramUserId} fileId=${media.fileId}`);

    // Connection link in caption
    if (caption?.startsWith("multica://connect?")) {
      await this.handleConnectionLink(ctx, telegramUserId, caption);
      return;
    }

    // Check if user is bound
    const user = await this.userStore.findByTelegramUserId(telegramUserId);
    if (!user) {
      const { text, keyboard } = this.buildWelcomeMessage();
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    }

    // ACK: 👀 reaction
    await this.addReaction(msg.chat.id, msg.message_id, "👀");
    this.storeMessageContext(user.deviceId, msg.chat.id, msg.message_id);

    // Process media → text description (async, may take a few seconds)
    const processedText = await this.processMedia({ ...media, caption: caption ?? undefined });

    // Prepend reply context if user is replying to a specific message
    const replyContext = extractReplyContext(ctx);
    const content = replyContext ? `${replyContext}\n${processedText}` : processedText;
    await this.routeToHub(user, content, ctx);
  }

  // ── Media processing ──

  /**
   * Download a file from the Telegram Bot API and save it locally.
   */
  private async downloadMedia(fileId: string): Promise<string> {
    if (!this.bot) throw new Error("Bot not initialized");

    const file = await this.bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error(`Telegram returned no file_path for fileId=${fileId}`);

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
    const ext = extname(filePath) || ".bin";
    const localPath = join(MEDIA_CACHE_DIR, `${uuidv7()}${ext}`);

    await mkdir(MEDIA_CACHE_DIR, { recursive: true });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    this.logger.debug(`Downloaded media: ${filePath} → ${localPath}`);
    return localPath;
  }

  /**
   * Process a media attachment into a text description for the agent.
   * Uses local whisper / OpenAI Vision / ffmpeg when available; graceful fallback otherwise.
   */
  private async processMedia(media: MediaAttachment): Promise<string> {
    try {
      const filePath = await this.downloadMedia(media.fileId);

      if (media.type === "image") {
        const description = await describeImage(filePath);
        if (description) {
          const parts = ["[Image]", `Description: ${description}`];
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          return parts.join("\n");
        }
        const parts = ["[image message received]", `File: ${filePath}`];
        if (media.caption) parts.push(`Caption: ${media.caption}`);
        return parts.join("\n");
      }

      if (media.type === "audio") {
        const transcript = await transcribeAudio(filePath);
        if (transcript) {
          const parts = ["[Voice Message]", `Transcript: ${transcript}`];
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          return parts.join("\n");
        }
        const parts = ["[audio message received]", `File: ${filePath}`];
        if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
        if (media.duration) parts.push(`Duration: ${media.duration}s`);
        if (media.caption) parts.push(`Caption: ${media.caption}`);
        return parts.join("\n");
      }

      if (media.type === "video") {
        const description = await describeVideo(filePath);
        if (description) {
          const parts = ["[Video]", `Description: ${description}`];
          if (media.duration) parts.push(`Duration: ${media.duration}s`);
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          return parts.join("\n");
        }
        const parts = ["[video message received]", `File: ${filePath}`];
        if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
        if (media.duration) parts.push(`Duration: ${media.duration}s`);
        if (media.caption) parts.push(`Caption: ${media.caption}`);
        return parts.join("\n");
      }

      // Document — no processing, just metadata
      const parts = ["[document message received]", `File: ${filePath}`];
      if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
      if (media.caption) parts.push(`Caption: ${media.caption}`);
      return parts.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to process ${media.type}: ${msg}`);
      return media.caption || `[${media.type} message received — processing failed]`;
    }
  }

  // ── Outbound: send to Telegram ──

  /**
   * Send text to a Telegram user/group by deviceId.
   * Applies Markdown → HTML formatting, text chunking, and reply-to.
   */
  async sendToTelegram(deviceId: string, text: string): Promise<void> {
    if (!this.bot) return;

    const user = await this.userStore.findByDeviceId(deviceId);
    if (!user) {
      this.logger.warn(`Telegram user not found for device: deviceId=${deviceId}`);
      return;
    }

    // Use chatId from message context (supports groups); fall back to user ID (private chat)
    const context = this.messageContexts.get(deviceId);
    const chatId = context?.telegramChatId ?? Number(user.telegramUserId);
    const chunks = chunkText(text);

    try {
      for (let i = 0; i < chunks.length; i++) {
        // Only reply_to on the first chunk
        const replyTo = i === 0 && context ? context.telegramMessageId : undefined;
        await this.sendFormatted(chatId, chunks[i]!, replyTo);
      }
      this.logger.debug(`Sent ${chunks.length} chunk(s) to Telegram: telegramUserId=${user.telegramUserId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send Telegram message: deviceId=${deviceId}, error=${message}`);
    }
  }

  /**
   * Send a single message with HTML formatting and optional reply-to.
   * Falls back to plain text if HTML parsing fails.
   */
  private async sendFormatted(
    chatId: number,
    text: string,
    replyToMessageId?: number,
  ): Promise<void> {
    if (!this.bot) return;

    const html = markdownToTelegramHtml(text);
    const extra: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyToMessageId) extra["reply_to_message_id"] = replyToMessageId;

    try {
      await this.bot.api.sendMessage(chatId, html, extra);
    } catch (err) {
      if (isParseError(err)) {
        this.logger.warn(`HTML parse failed, retrying as plain text`);
        const plainExtra: Record<string, unknown> = {};
        if (replyToMessageId) plainExtra["reply_to_message_id"] = replyToMessageId;
        await this.bot.api.sendMessage(chatId, text, plainExtra);
      } else {
        throw err;
      }
    }
  }

  /** Send a file (photo/document/video/audio) to a Telegram user */
  private async sendFileToTelegram(
    deviceId: string,
    data: Buffer,
    type: string,
    caption?: string,
    filename?: string,
  ): Promise<void> {
    if (!this.bot) return;

    const user = await this.userStore.findByDeviceId(deviceId);
    if (!user) return;

    const context = this.messageContexts.get(deviceId);
    const chatId = context?.telegramChatId ?? Number(user.telegramUserId);
    const inputFile = new InputFile(data, filename);

    // Format caption as HTML with fallback
    const rawCaption = caption?.slice(0, 1024);
    const captionHtml = rawCaption ? markdownToTelegramHtml(rawCaption) : undefined;
    const extra = captionHtml ? { caption: captionHtml, parse_mode: "HTML" as const } : {};

    try {
      switch (type) {
        case "photo":
          await this.bot.api.sendPhoto(chatId, inputFile, extra);
          break;
        case "video":
          await this.bot.api.sendVideo(chatId, inputFile, extra);
          break;
        case "audio":
          await this.bot.api.sendAudio(chatId, inputFile, extra);
          break;
        case "voice":
          await this.bot.api.sendVoice(chatId, inputFile, extra);
          break;
        case "document":
        default:
          await this.bot.api.sendDocument(chatId, inputFile, extra);
          break;
      }
      this.logger.debug(`Sent ${type} to Telegram: deviceId=${deviceId}`);
    } catch (err) {
      // If HTML caption fails, retry without formatting
      if (isParseError(err) && rawCaption) {
        this.logger.warn("Media caption HTML parse failed, retrying as plain text");
        const plainExtra = { caption: rawCaption };
        switch (type) {
          case "photo":
            await this.bot.api.sendPhoto(chatId, inputFile, plainExtra);
            break;
          case "video":
            await this.bot.api.sendVideo(chatId, inputFile, plainExtra);
            break;
          case "audio":
            await this.bot.api.sendAudio(chatId, inputFile, plainExtra);
            break;
          case "voice":
            await this.bot.api.sendVoice(chatId, inputFile, plainExtra);
            break;
          case "document":
          default:
            await this.bot.api.sendDocument(chatId, inputFile, plainExtra);
            break;
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send ${type}: deviceId=${deviceId}, error=${message}`);
      }
    }
  }

  // ── Reactions ──

  private async addReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMessageReaction(
        chatId,
        messageId,
        // Grammy expects a specific emoji union type; cast since our interface accepts any string
        [{ type: "emoji", emoji } as unknown as { type: "emoji"; emoji: "👀" }],
      );
    } catch {
      // Best-effort — reaction failure is not critical
    }
  }

  private async removeReaction(chatId: number, messageId: number): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Best-effort
    }
  }

  // ── Typing indicators ──

  private startTyping(deviceId: string): void {
    if (this.typingTimers.has(deviceId)) return;

    const context = this.messageContexts.get(deviceId);
    if (!context) return;

    const chatId = context.telegramChatId;
    const send = () => {
      void this.bot?.api.sendChatAction(chatId, "typing").catch(() => {});
    };
    send();
    const interval = setInterval(send, 5000);
    this.typingTimers.set(deviceId, interval);

    // Safety timeout: auto-stop if no message_end/agent_error arrives
    setTimeout(() => {
      if (this.typingTimers.get(deviceId) === interval) {
        this.stopTyping(deviceId);
      }
    }, TYPING_TIMEOUT_MS);
  }

  private stopTyping(deviceId: string): void {
    const timer = this.typingTimers.get(deviceId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(deviceId);
    }
  }

  // ── Message context tracking ──

  private storeMessageContext(deviceId: string, chatId: number, messageId: number): void {
    this.messageContexts.set(deviceId, {
      telegramChatId: chatId,
      telegramMessageId: messageId,
    });
  }

  /** Remove context and 👀 reaction for a device after response is sent */
  private async clearMessageContext(deviceId: string): Promise<void> {
    const context = this.messageContexts.get(deviceId);
    if (context) {
      await this.removeReaction(context.telegramChatId, context.telegramMessageId);
      this.messageContexts.delete(deviceId);
    }
  }

  // ── Connection & routing ──

  /** Handle a multica://connect? connection link pasted as text */
  private async handleConnectionLink(ctx: Context, telegramUserId: string, text: string): Promise<void> {
    let connectionInfo: ConnectionInfo;
    try {
      connectionInfo = parseConnectionCode(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid connection link";
      await ctx.reply(`Connection failed: ${message}\n\nPlease generate a new link and try again.`);
      return;
    }

    await this.connectUser(ctx, telegramUserId, connectionInfo);
  }

  /**
   * Shared connection flow used by both paste-link and /start deep link.
   * Checks Hub online → registers virtual device → sends verify RPC → saves to DB.
   */
  private async connectUser(ctx: Context, telegramUserId: string, connectionInfo: ConnectionInfo): Promise<void> {
    const msg = ctx.message;

    // 1. Check Hub is online
    if (!this.eventsGateway.isDeviceRegistered(connectionInfo.hubId)) {
      await ctx.reply(
        `<b>\u26a0\ufe0f Connection failed</b>\n\n` +
          `Hub is not online.\n\n` +
          `Make sure the Multica Desktop app is running and connected to the Gateway, then try again.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // 2. Unregister old virtual device if user is re-binding
    const existingUser = await this.userStore.findByTelegramUserId(telegramUserId);
    if (existingUser && this.eventsGateway.isDeviceRegistered(existingUser.deviceId)) {
      this.eventsGateway.unregisterVirtualDevice(existingUser.deviceId);
    }

    // 3. Generate device ID and register virtual device
    const deviceId = `tg-${generateEncryptedId()}`;
    this.registerVirtualDeviceForUser(deviceId, telegramUserId);

    // 4. Send verify RPC
    try {
      await ctx.reply(
        `<b>\u23f3 Connecting...</b>\n\nPlease approve the connection on your Desktop app.`,
        { parse_mode: "HTML" },
      );

      const result = await this.sendVerifyRpc(deviceId, connectionInfo.hubId, connectionInfo.token, {
        platform: "telegram",
        clientName: msg?.from?.username
          ? `Telegram @${msg.from.username}`
          : `Telegram ${msg?.from?.first_name ?? telegramUserId}`,
      });

      // 5. Save to DB
      await this.userStore.upsert({
        telegramUserId,
        hubId: connectionInfo.hubId,
        agentId: connectionInfo.agentId,
        deviceId,
        telegramUsername: msg?.from?.username,
        telegramFirstName: msg?.from?.first_name,
        telegramLastName: msg?.from?.last_name,
      });

      const successKeyboard = new InlineKeyboard()
        .text("Check status", CB_CHECK_STATUS)
        .text("Help", CB_SHOW_HELP);

      await ctx.reply(
        `<b>\u2705 Connected successfully!</b>\n\n` +
          `Hub: <code>${result.hubId}</code>\n` +
          `Agent: <code>${result.agentId}</code>\n\n` +
          `You can now send messages to interact with your agent.`,
        { parse_mode: "HTML", reply_markup: successKeyboard },
      );

      await this.sendAgentWelcomeAfterConnect({
        telegramUserId,
        deviceId,
        hubId: result.hubId,
        agentId: result.agentId,
        languageCode: msg?.from?.language_code,
        firstName: msg?.from?.first_name,
        isReconnect: !!existingUser,
      });

      this.logger.log(
        `Telegram user verified: telegramUserId=${telegramUserId}, hubId=${connectionInfo.hubId}, deviceId=${deviceId}`,
      );
    } catch (error) {
      // Cleanup virtual device on failure
      this.eventsGateway.unregisterVirtualDevice(deviceId);

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("REJECTED")) {
        await ctx.reply(
          `<b>\u274c Connection rejected</b>\n\nThe connection was declined on the Desktop app.`,
          { parse_mode: "HTML" },
        );
      } else if (message.includes("timed out")) {
        await ctx.reply(
          `<b>\u274c Connection timed out</b>\n\nPlease try again and approve the connection on your Desktop app within 30 seconds.`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(
          `<b>\u274c Connection failed</b>\n\n${message}\n\nPlease try again.`,
          { parse_mode: "HTML" },
        );
      }

      this.logger.warn(`Telegram verify failed: telegramUserId=${telegramUserId}, error=${message}`);
    }
  }

  private shouldSendConnectWelcome(telegramUserId: string): boolean {
    const now = Date.now();
    const lastSentAt = this.welcomeSentAt.get(telegramUserId);
    if (lastSentAt && now - lastSentAt < WELCOME_COOLDOWN_MS) {
      return false;
    }
    this.welcomeSentAt.set(telegramUserId, now);
    return true;
  }

  private buildFallbackConnectWelcome(firstName: string | undefined, isReconnect: boolean): string {
    const safeName = firstName?.trim() || "there";
    if (isReconnect) {
      return (
        `Welcome back, ${safeName}. I am your Multica AI agent and I am ready again.\n\n` +
        `I can help with research, drafting, and step-by-step problem solving.\n` +
        `What should we work on now?`
      );
    }
    return (
      `Hi ${safeName}, I am your Multica AI agent.\n\n` +
      `I can help with research, drafting, and step-by-step problem solving.\n` +
      `What would you like to do first?`
    );
  }

  private async sendAgentWelcomeAfterConnect(opts: {
    telegramUserId: string;
    deviceId: string;
    hubId: string;
    agentId: string;
    languageCode?: string;
    firstName?: string;
    isReconnect: boolean;
  }): Promise<void> {
    if (!this.shouldSendConnectWelcome(opts.telegramUserId)) {
      this.logger.debug(`Connect welcome skipped by cooldown: telegramUserId=${opts.telegramUserId}`);
      return;
    }

    try {
      const language = opts.languageCode?.trim().slice(0, 16) || undefined;
      const firstName = opts.firstName?.trim().slice(0, 32) || undefined;
      const result = await this.sendGenerateChannelWelcomeRpc(opts.deviceId, opts.hubId, {
        agentId: opts.agentId,
        channel: "telegram",
        language,
        firstName,
        isReconnect: opts.isReconnect,
      });
      const welcomeText = result.text.trim();
      if (welcomeText) {
        await this.sendToTelegram(opts.deviceId, welcomeText);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`generateChannelWelcome failed: deviceId=${opts.deviceId}, error=${message}`);
    }

    await this.sendToTelegram(
      opts.deviceId,
      this.buildFallbackConnectWelcome(opts.firstName, opts.isReconnect),
    );
  }

  private sendRpc<TParams, TResult>(
    deviceId: string,
    hubId: string,
    method: string,
    params: TParams,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const requestId = uuidv7();

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const payload: RequestPayload<TParams> = {
        requestId,
        method,
        params,
      };

      const message: RoutedMessage<RequestPayload<TParams>> = {
        id: uuidv7(),
        uid: null,
        from: deviceId,
        to: hubId,
        action: RequestAction,
        payload,
      };

      const sent = this.eventsGateway.routeFromVirtualDevice(message);
      if (!sent) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`Failed to route ${method} request to Hub`));
      }
    });
  }

  /** Send a verify RPC to Hub via the virtual device */
  private sendVerifyRpc(
    deviceId: string,
    hubId: string,
    token: string,
    meta: DeviceMeta,
  ): Promise<VerifyResult> {
    return this.sendRpc<VerifyParams, VerifyResult>(
      deviceId,
      hubId,
      "verify",
      { token, meta },
      VERIFY_TIMEOUT_MS,
      "Verify request timed out",
    );
  }

  /** Ask Hub agent to generate a proactive Telegram welcome message */
  private sendGenerateChannelWelcomeRpc(
    deviceId: string,
    hubId: string,
    params: GenerateChannelWelcomeParams,
  ): Promise<GenerateChannelWelcomeResult> {
    return this.sendRpc<GenerateChannelWelcomeParams, GenerateChannelWelcomeResult>(
      deviceId,
      hubId,
      "generateChannelWelcome",
      params,
      WELCOME_RPC_TIMEOUT_MS,
      "Welcome generation timed out",
    );
  }

  /** Route a regular chat message to the user's Hub agent */
  private async routeToHub(user: TelegramUser, text: string, ctx: Context): Promise<void> {
    // Ensure Hub is online
    if (!this.eventsGateway.isDeviceRegistered(user.hubId)) {
      await ctx.reply(
        "Your Hub is currently offline.\n\n" +
          "Make sure the Multica Desktop app is running and connected to the Gateway.",
      );
      return;
    }

    // Ensure virtual device is registered (may have been lost on gateway restart)
    if (!this.eventsGateway.isDeviceRegistered(user.deviceId)) {
      this.registerVirtualDeviceForUser(user.deviceId, user.telegramUserId);
    }

    // Send message to Hub
    const message: RoutedMessage = {
      id: uuidv7(),
      uid: null,
      from: user.deviceId,
      to: user.hubId,
      action: "message",
      payload: { agentId: user.agentId, content: text },
    };

    const sent = this.eventsGateway.routeFromVirtualDevice(message);
    if (!sent) {
      await ctx.reply("Failed to send message. Please try again.");
      return;
    }

    this.logger.debug(
      `Routed message to Hub: deviceId=${user.deviceId}, hubId=${user.hubId}, agentId=${user.agentId}`,
    );
  }

  // ── Virtual device registration ──

  /**
   * Register a virtual device with a sendCallback that handles:
   * - RPC responses (verify)
   * - Stream events (typing, text delivery with formatting/chunking/reply-to)
   * - File delivery
   * - Regular messages
   * - Errors
   */
  private registerVirtualDeviceForUser(deviceId: string, telegramUserId: string): void {
    this.eventsGateway.registerVirtualDevice(deviceId, {
      sendCallback: (_event: string, data: unknown) => {
        const msg = data as RoutedMessage;
        if (!msg || !msg.action) return;

        // RPC response — resolve/reject pending request
        if (msg.action === ResponseAction) {
          const response = msg.payload as ResponsePayload;
          const pending = this.pendingRequests.get(response.requestId);
          if (pending) {
            this.pendingRequests.delete(response.requestId);
            clearTimeout(pending.timer);
            if (response.ok) {
              pending.resolve(response.payload);
            } else {
              pending.reject(new Error(`RPC error [${response.error.code}]: ${response.error.message}`));
            }
          }
          return;
        }

        // Stream event — typing indicator + formatted text delivery
        if (msg.action === StreamAction) {
          const streamPayload = msg.payload as StreamPayload;
          const event = streamPayload?.event;
          if (!event || !("type" in event)) return;

          // Start typing when LLM begins generating
          if (event.type === "message_start") {
            this.startTyping(deviceId);
            return;
          }

          // Stop typing + send formatted text on message_end
          if (event.type === "message_end") {
            const agentMsg = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message;

            // Tool narration: if the message contains tool_use blocks,
            // it's intermediate text (e.g. "Let me search...") before a tool call.
            // Send/edit an editable status message and keep typing.
            const hasToolUse = agentMsg?.content?.some((c) => c.type === "tool_use" || c.type === "toolCall") ?? false;
            if (hasToolUse) {
              const narration = agentMsg?.content
                ?.filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("") ?? "";
              if (narration) {
                void this.sendToTelegram(deviceId, narration).then(() => {
                  // Re-send typing indicator — Telegram clears it when a message is sent
                  const ctx = this.messageContexts.get(deviceId);
                  if (ctx) {
                    void this.bot?.api.sendChatAction(ctx.telegramChatId, "typing").catch(() => {});
                  }
                });
              }
              return;
            }

            this.stopTyping(deviceId);
            if (agentMsg?.content) {
              const textContent = agentMsg.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("");
              if (textContent) {
                void this.sendToTelegram(deviceId, textContent).then(() => {
                  void this.clearMessageContext(deviceId);
                });
              }
            }
            return;
          }

          // Stop typing on error
          if (event.type === "agent_error") {
            this.stopTyping(deviceId);
            void this.clearMessageContext(deviceId);
            return;
          }

          return;
        }

        // Send file — Hub agent wants to send a file to the Telegram user
        if (msg.action === "send_file") {
          const payload = msg.payload as {
            data?: string;
            type?: string;
            caption?: string;
            filename?: string;
          };
          if (payload?.data) {
            void this.sendFileToTelegram(
              deviceId,
              Buffer.from(payload.data, "base64"),
              payload.type ?? "document",
              payload.caption,
              payload.filename,
            );
          }
          return;
        }

        // Regular message (e.g., "message" action from Hub)
        if (msg.action === "message") {
          const payload = msg.payload as { content?: string; agentId?: string };
          if (payload?.content) {
            void this.sendToTelegram(deviceId, payload.content);
          }
          return;
        }

        // Error messages
        if (msg.action === "error") {
          this.stopTyping(deviceId);
          void this.clearMessageContext(deviceId);
          const payload = msg.payload as { message?: string; code?: string };
          if (payload?.message) {
            void this.sendToTelegram(deviceId, `Error: ${payload.message}`);
          }
        }
      },
    });
  }

}
