import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SideChat, SideChatOptions } from "../side-chat.ts";
import { formatElapsed, SideChatStore } from "../side-chat.ts";

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function sanitizeText(text: string) {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function status(chat: SideChat, theme: Theme) {
  switch (chat.status) {
    case "running":
      return theme.fg("warning", "answering");
    case "done":
      return theme.fg("success", "answered");
    case "cancelled":
      return theme.fg("muted", "cancelled");
    case "error":
      return theme.fg("error", "failed");
  }
}

function transcriptLines(chat: SideChat, width: number, theme: Theme) {
  const lines: string[] = [];
  const addWrapped = (text: string, color: "text" | "muted") => {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(color, sanitizeText(text).trim()),
        Math.max(10, width),
      ),
    );
  };

  for (const turn of chat.transcript) {
    if (lines.length > 0) lines.push("");
    if (turn.role === "user") {
      const wrapped = wrapTextWithAnsi(
        sanitizeText(turn.text).trim(),
        Math.max(10, width - 2),
      );
      wrapped.forEach((line, index) =>
        lines.push(
          truncateToWidth(
            `${index === 0 ? theme.fg("accent", "> ") : "  "}${theme.fg("userMessageText", line)}`,
            width,
          ),
        ),
      );
      continue;
    }
    if (turn.thinking) {
      addWrapped(`~ ${turn.thinking}`, "muted");
      lines.push("");
    }
    if (turn.text) addWrapped(turn.text, "text");
  }

  if (chat.liveThinking || chat.liveText) {
    if (lines.length > 0) lines.push("");
    if (chat.liveThinking) {
      addWrapped(`~ ${chat.liveThinking}`, "muted");
      if (chat.liveText) lines.push("");
    }
    if (chat.liveText) addWrapped(chat.liveText, "text");
  }

  return lines;
}

export async function openSideChat(
  ctx: ExtensionCommandContext,
  store: SideChatStore,
  id: string,
  options: SideChatOptions,
) {
  if (!store.get(id)) return;
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new SideChatView(tui, theme, keybindings, store, id, options, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

export async function pickSideChat(
  ctx: ExtensionCommandContext,
  store: SideChatStore,
  optionsFor: (chat: SideChat) => SideChatOptions | undefined,
) {
  const chats = store.list();
  if (chats.length === 0) {
    ctx.ui.notify("No by-the-way chats yet. Start one with /btw.", "info");
    return;
  }
  const labels = chats.map(
    (chat) => `${chat.id} · ${chat.title} · ${chat.status}`,
  );
  const selected = await ctx.ui.select("by-the-way chats", labels);
  if (!selected) return;
  const chat = chats[labels.indexOf(selected)];
  const options = chat && optionsFor(chat);
  if (chat && options) await openSideChat(ctx, store, chat.id, options);
}

const SCROLL_STEP = 6;

class SideChatView implements Component, Focusable {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly store: SideChatStore;
  private readonly id: string;
  private readonly options: SideChatOptions;
  private readonly done: (value: null) => void;
  private scrollOffset = 0;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    store: SideChatStore,
    id: string,
    options: SideChatOptions,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.store = store;
    this.id = id;
    this.options = options;
    this.done = done;
    this.unsubscribe = store.subscribeTo(id, () => this.scheduleRender());
    this.ticker = setInterval(() => tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      const chat = this.chat();
      if (!text || chat?.status === "running") return;
      this.input.setValue("");
      this.scrollOffset = 0;
      void this.store.send(this.id, text, this.options);
      this.tui.requestRender();
    };
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private chat() {
    return this.store.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose() {
    this.cleanup();
  }

  handleInput(data: string) {
    if (this.keybindings.matches(data, "app.clear")) {
      this.store.abort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight() {
    return Math.max(6, (this.tui.terminal.rows || 30) - 8);
  }

  render(width: number) {
    const border = this.theme.fg(
      "borderAccent",
      "─".repeat(Math.max(1, width)),
    );
    const chat = this.chat();
    if (!chat) return [border, this.theme.fg("dim", "Side chat closed"), border];

    const lines = [
      border,
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold(`by the way · ${chat.title}`))}${this.theme.fg("muted", ` · ${chat.id} · ${formatElapsed(chat)} · `)}${status(chat, this.theme)}${this.theme.fg("dim", ` · ${chat.modelLabel}`)}`,
        width,
      ),
      border,
    ];

    const transcript = transcriptLines(chat, width, this.theme);
    const viewport = this.viewportHeight();
    const extraRows = (chat.errorText ? 1 : 0) + (this.scrollOffset > 0 ? 1 : 0);
    const capacity = Math.max(1, viewport - extraRows);
    const maxOffset = Math.max(0, transcript.length - capacity);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = transcript.length - this.scrollOffset;
    const body = transcript.slice(Math.max(0, end - capacity), end);
    if (body.length === 0) body.push(this.theme.fg("dim", "(waiting for a response)"));
    if (chat.errorText) {
      body.push(
        truncateToWidth(
          this.theme.fg("error", `Side chat failed: ${chat.errorText}`),
          width,
        ),
      );
    }
    if (this.scrollOffset > 0) {
      body.push(this.theme.fg("dim", `... ${this.scrollOffset} lines below`));
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));
    lines.push(border, ...this.input.render(width));
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} cancel response · ↑/↓ scroll · pgup/pgdn page`,
        ),
        width,
      ),
      border,
    );
    return lines;
  }

  invalidate() {
    this.input.invalidate();
  }
}
