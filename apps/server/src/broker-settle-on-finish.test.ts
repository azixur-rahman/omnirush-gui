// The 2.x engine stops reading a model stream once it has the answer: the broker still reads the gateway's stream to
// its end, so the gateway settles the request as served (not a client disconnect). A Stop before the answer finished
// still cancels the gateway request.
import { expect, test } from "bun:test";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";

const encoder = new TextEncoder();
const event = (e: Record<string, unknown>) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

function gateway(stopFirst = false) {
  const state = { readToEnd: false, cancelled: false, aborted: false };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { state.aborted = true; });
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(event({ type: "response.output_text.delta", delta: "Hello" }));
        else if (step === 2) { await new Promise((r) => setTimeout(r, stopFirst ? 300 : 0)); controller.enqueue(event({ type: "response.completed", response: { id: "r1", output: [] } })); }
        else if (step === 3) { await new Promise((r) => setTimeout(r, 50)); controller.enqueue(encoder.encode(": settled\n\n")); }
        else { state.readToEnd = true; controller.close(); }
      },
      cancel() { state.cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const broker = new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a", refreshToken: "r" },
    engineToken: "local-engine-token",
    fetch: fetchImpl as never,
  });
  return { broker, state };
}

const post = (signal?: AbortSignal) => new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
  method: "POST",
  headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", "x-omnirush-session-id": "ses_s" },
  body: JSON.stringify({ model: "omnirush/gpt-6-astra", input: [], stream: true }),
  ...(signal ? { signal } : {}),
});

test("the engine stops reading after response.completed: the gateway stream is still read to its end", async () => {
  const { broker, state } = gateway();
  const engine = new AbortController();
  const response = await broker.handle(post(engine.signal), "responses");
  const reader = response.body!.getReader();
  let seen = "";
  while (!seen.includes("response.completed")) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  engine.abort();
  await new Promise((r) => setTimeout(r, 200));
  expect(state.readToEnd).toBe(true);
  expect(state.cancelled).toBe(false);
  expect(state.aborted).toBe(false);
});

test("a Stop before the answer finished cancels the gateway request", async () => {
  // The answer is still being written when the person stops (the gateway is slow to its final event).
  const { broker, state } = gateway(true);
  const engine = new AbortController();
  const response = await broker.handle(post(engine.signal), "responses");
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  engine.abort();
  await new Promise((r) => setTimeout(r, 500));
  expect(state.readToEnd).toBe(false);
  expect(state.cancelled || state.aborted).toBe(true);
});

test("the engine closes the step right after a finished tool call (before response.completed): still read to its end", async () => {
  const state = { readToEnd: false, cancelled: false, aborted: false };
  let step = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { state.aborted = true; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(event({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "shell", arguments: "" } }));
        else if (step === 2) controller.enqueue(event({ type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}", call_id: "call_1" } }));
        else if (step === 3) { await new Promise((r) => setTimeout(r, 300)); controller.enqueue(event({ type: "response.completed", response: { id: "r1", output: [] } })); }
        else { state.readToEnd = true; controller.close(); }
      },
      cancel() { state.cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const broker = new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a", refreshToken: "r" },
    engineToken: "local-engine-token",
    fetch: fetchImpl as never,
  });
  const engine = new AbortController();
  const response = await broker.handle(post(engine.signal), "responses");
  const reader = response.body!.getReader();
  let seen = "";
  while (!seen.includes("response.output_item.done")) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  engine.abort();
  await new Promise((r) => setTimeout(r, 600));
  expect(state.readToEnd).toBe(true);
  expect(state.cancelled).toBe(false);
  expect(state.aborted).toBe(false);
});
