import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export type SideChatStatus = "running" | "done" | "cancelled" | "error";

export interface SideChatTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly thinking?: string;
}

export interface SideChat {
  readonly id: string;
  readonly title: string;
  readonly modelLabel: string;
  readonly createdAt: number;
  readonly messages: Message[];
  readonly transcript: SideChatTurn[];
  status: SideChatStatus;
  settledAt?: number;
  errorText?: string;
  liveText: string;
  liveThinking: string;
  usageTokens?: number;
  abortController?: AbortController;
}

export interface SideChatOptions {
  readonly model: Model<Api>;
  readonly modelLabel: string;
  readonly systemPrompt: string;
  readonly forkedMessages: Message[];
  readonly requestOptions: Omit<SimpleStreamOptions, "signal">;
}

export type SideChatStream = (
  model: Model<Api>,
  context: { systemPrompt?: string; messages: Message[] },
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

function messageText(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function messageThinking(message: AssistantMessage) {
  return message.content
    .flatMap((part) =>
      part.type === "thinking" && !part.redacted ? [part.thinking] : [],
    )
    .join("\n");
}

export function forkMessages(messages: Message[]) {
  return structuredClone(messages);
}

export class SideChatStore {
  private readonly chats = new Map<string, SideChat>();
  private readonly listeners = new Set<() => void>();
  private readonly chatListeners = new Map<string, Set<() => void>>();
  private readonly createStream: SideChatStream;
  private readonly onSettled?: (chat: SideChat) => void;
  private nextId = 1;

  constructor(
    createStream: SideChatStream = streamSimple,
    onSettled?: (chat: SideChat) => void,
  ) {
    this.createStream = createStream;
    this.onSettled = onSettled;
  }

  create(options: SideChatOptions, prompt: string, title: string) {
    const id = `btw-${this.nextId++}`;
    const chat: SideChat = {
      id,
      title,
      modelLabel: options.modelLabel,
      createdAt: Date.now(),
      messages: forkMessages(options.forkedMessages),
      transcript: [],
      status: "done",
      liveText: "",
      liveThinking: "",
    };
    this.chats.set(id, chat);
    this.notify(id);
    void this.send(id, prompt, options);
    return chat;
  }

  list(): ReadonlyArray<SideChat> {
    return [...this.chats.values()];
  }

  get(id: string) {
    return this.chats.get(id);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTo(id: string, listener: () => void) {
    const listeners = this.chatListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.chatListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.chatListeners.delete(id);
    };
  }

  async send(id: string, text: string, options: SideChatOptions) {
    const chat = this.chats.get(id);
    const prompt = text.trim();
    if (!chat || !prompt || chat.status === "running") return false;

    chat.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    chat.transcript.push({ role: "user", text: prompt });
    chat.status = "running";
    chat.settledAt = undefined;
    chat.errorText = undefined;
    chat.liveText = "";
    chat.liveThinking = "";
    const abortController = new AbortController();
    chat.abortController = abortController;
    this.notify(id);

    try {
      const stream = this.createStream(
        options.model,
        { systemPrompt: options.systemPrompt, messages: chat.messages },
        { ...options.requestOptions, signal: abortController.signal },
      );

      for await (const event of stream) {
        if (event.type === "text_delta") chat.liveText += event.delta;
        if (event.type === "thinking_delta") chat.liveThinking += event.delta;
        if (event.type === "text_delta" || event.type === "thinking_delta") {
          this.notify(id);
          continue;
        }
        if (event.type === "done") {
          this.finish(chat, event.message, "done");
          return true;
        }
        if (event.type === "error") {
          this.finish(
            chat,
            event.error,
            event.reason === "aborted" ? "cancelled" : "error",
          );
          return event.reason === "aborted";
        }
      }
      this.fail(chat, "The side chat response ended unexpectedly.");
      return false;
    } catch (error) {
      if (abortController.signal.aborted) {
        this.finishWithoutMessage(chat, "cancelled");
        return true;
      }
      this.fail(chat, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  abort(id: string) {
    const chat = this.chats.get(id);
    if (chat?.status !== "running") return;
    chat.abortController?.abort(new Error("Side chat cancelled"));
  }

  dispose() {
    for (const chat of this.chats.values()) chat.abortController?.abort();
    this.chats.clear();
    this.listeners.clear();
    this.chatListeners.clear();
  }

  private finish(
    chat: SideChat,
    message: AssistantMessage,
    status: "done" | "cancelled" | "error",
  ) {
    chat.messages.push(message);
    const text = messageText(message) || chat.liveText;
    const thinking = messageThinking(message) || chat.liveThinking;
    if (text || thinking) {
      chat.transcript.push({
        role: "assistant",
        text,
        thinking: thinking || undefined,
      });
    }
    chat.status = status;
    chat.errorText = status === "error" ? message.errorMessage ?? "Response failed" : undefined;
    chat.usageTokens = message.usage.totalTokens;
    this.settle(chat);
  }

  private finishWithoutMessage(
    chat: SideChat,
    status: "cancelled" | "error",
  ) {
    if (chat.liveText || chat.liveThinking) {
      chat.transcript.push({
        role: "assistant",
        text: chat.liveText,
        thinking: chat.liveThinking || undefined,
      });
    }
    chat.status = status;
    this.settle(chat);
  }

  private fail(chat: SideChat, message: string) {
    chat.errorText = message.slice(0, 4096);
    this.finishWithoutMessage(chat, "error");
  }

  private settle(chat: SideChat) {
    chat.settledAt = Date.now();
    chat.abortController = undefined;
    chat.liveText = "";
    chat.liveThinking = "";
    this.notify(chat.id);
    this.onSettled?.(chat);
  }

  private notify(id: string) {
    for (const listener of this.listeners) listener();
    for (const listener of this.chatListeners.get(id) ?? []) listener();
  }
}

export function formatElapsed(chat: Pick<SideChat, "createdAt" | "settledAt">) {
  const totalSeconds = Math.max(
    0,
    Math.round(((chat.settledAt ?? Date.now()) - chat.createdAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}
