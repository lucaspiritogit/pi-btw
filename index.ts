import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { deriveBtwTitle } from "./src/by-the-way.ts";
import { formatActivityStatus } from "./src/format.ts";
import {
  SideChatStore,
  type SideChat,
  type SideChatOptions,
} from "./src/side-chat.ts";
import { openSideChat, pickSideChat } from "./src/ui/side-chat.ts";

const SIDE_CHAT_INSTRUCTIONS = `This is a by-the-way side chat forked from the current conversation.
Answer the user's side questions using the copied conversation as context.
This chat has no tools and cannot modify files or control the main conversation.`;

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  const optionsByChatId = new Map<string, SideChatOptions>();
  const store = new SideChatStore(undefined, (chat) => {
    updateStatus();
    if (!ui) return;
    if (chat.status === "cancelled") {
      ui.notify(`by the way “${chat.title}” was cancelled`, "info");
    } else if (chat.status === "error") {
      ui.notify(`by the way “${chat.title}” failed — reopen it with /btws`, "error");
    } else {
      ui.notify(`by the way “${chat.title}” answered — reopen it with /btws`, "info");
    }
  });

  const updateStatus = () => {
    if (!ui) return;
    const chats = store.list();
    if (chats.length === 0) {
      ui.setStatus("btw", undefined);
      return;
    }
    ui.setStatus(
      "btw",
      formatActivityStatus(ui.theme, {
        running: chats.filter((chat) => chat.status === "running").length,
        done: chats.filter((chat) => chat.status === "done").length,
        cancelled: chats.filter((chat) => chat.status === "cancelled").length,
        failed: chats.filter((chat) => chat.status === "error").length,
      }),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    unsubscribeStatus?.();
    unsubscribeStatus = store.subscribe(updateStatus);
    updateStatus();
  });

  pi.on("session_shutdown", () => {
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    ui?.setStatus("btw", undefined);
    ui = undefined;
    optionsByChatId.clear();
    store.dispose();
  });

  const buildOptions = async (ctx: ExtensionCommandContext) => {
    if (!ctx.model) throw new Error("No model selected");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
    }
    const thinkingLevel = pi.getThinkingLevel();
    return {
      model: ctx.model,
      modelLabel: `${ctx.model.provider}/${ctx.model.id}`,
      systemPrompt: `${ctx.getSystemPrompt()}\n\n${SIDE_CHAT_INSTRUCTIONS}`,
      forkedMessages: convertToLlm(
        buildSessionContext(
          ctx.sessionManager.getEntries(),
          ctx.sessionManager.getLeafId(),
        ).messages,
      ),
      requestOptions: {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        sessionId: uuidv7(),
      },
    } satisfies SideChatOptions;
  };

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      prompt = (await ctx.ui.input("by the way", "Ask a side question…"))?.trim() ?? "";
      if (!prompt) return;
    }

    try {
      const options = await buildOptions(ctx);
      const chat = store.create(options, prompt, deriveBtwTitle(prompt));
      optionsByChatId.set(chat.id, options);
      await openSideChat(ctx, store, chat.id, options);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerCommand("btw", {
    description: "Open a side chat forked from the current conversation",
    handler: runByTheWay,
  });

  pi.registerCommand("btws", {
    description: "List and reopen by-the-way side chats",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("by-the-way chats are only available in the TUI", "error");
        return;
      }
      await pickSideChat(ctx, store, (chat: SideChat) =>
        optionsByChatId.get(chat.id),
      );
    },
  });
}
