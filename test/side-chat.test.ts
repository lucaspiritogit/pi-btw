import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import {
  forkMessages,
  SideChatStore,
  type SideChatOptions,
  type SideChatStream,
} from "../src/side-chat.ts";

const model: Model<Api> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function options(forkedMessages: Message[]): SideChatOptions {
  return {
    model,
    modelLabel: "test/test-model",
    systemPrompt: "Side chat only; no tools.",
    forkedMessages,
    requestOptions: {},
  };
}

async function waitUntilSettled(store: SideChatStore, id: string) {
  while (store.get(id)?.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("forkMessages clones the current conversation", () => {
  const original: Message[] = [
    { role: "user", content: "main conversation", timestamp: 1 },
  ];
  const fork = forkMessages(original);
  (fork[0] as { content: string }).content = "changed fork";
  assert.equal(original[0].content, "main conversation");
});

test("a side chat sends a copied conversation directly to the model without tools", async () => {
  let request:
    | { systemPrompt?: string; messages: Message[]; hasTools: boolean }
    | undefined;
  const createStream: SideChatStream = (_model, context) => {
    request = {
      ...context,
      messages: structuredClone(context.messages),
      hasTools: "tools" in context,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("side answer") }));
    return stream;
  };
  const original: Message[] = [
    { role: "user", content: "main question", timestamp: 1 },
    assistant("main answer"),
  ];
  const store = new SideChatStore(createStream);
  const chat = store.create(options(original), "side question", "side question");
  await waitUntilSettled(store, chat.id);

  assert.equal(request?.hasTools, false);
  assert.deepEqual(
    request?.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(original.length, 2);
  assert.equal(store.get(chat.id)?.transcript.at(-1)?.text, "side answer");
  assert.equal(store.get(chat.id)?.status, "done");
});

test("cancelling a response marks the side chat as cancelled, not failed", async () => {
  const createStream: SideChatStream = (_model, _context, requestOptions) => {
    const stream = createAssistantMessageEventStream();
    requestOptions.signal?.addEventListener(
      "abort",
      () => {
        const message = assistant("", "aborted");
        stream.push({ type: "error", reason: "aborted", error: message });
      },
      { once: true },
    );
    return stream;
  };
  const store = new SideChatStore(createStream);
  const chat = store.create(options([]), "cancel me", "cancel me");
  store.abort(chat.id);
  await waitUntilSettled(store, chat.id);

  assert.equal(store.get(chat.id)?.status, "cancelled");
  assert.equal(store.get(chat.id)?.errorText, undefined);
});
