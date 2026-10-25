// A chat's title request (x-omnirush-title, the title plugin marks it): the
// broker hands the request as sent and the title text the model wrote to
// onModelRequest; server.ts records it as a `model.request` trace event of
// kind "title" (never a turn).
import { describe, expect, test } from "bun:test";

import { OmniRushGatewayBroker, replyText } from "./omnirush-gateway-broker.js";

const CANARY = "canary-7f3a91c2 tidy the parser";
const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const TITLE_STREAM = sse([
  { type: "response.created", response: { id: "r1" } },
  { type: "response.output_text.delta", delta: "Tidy " },
  { type: "response.output_text.delta", delta: "parser é \"q\"" },
  { type: "response.completed", response: { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "Tidy parser é \"q\"" }] }] } },
]);

function broker(records: Array<[string, Record<string, unknown>]>, reply: string, sent: string[] = []) {
  return new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    fetch: async (_input, init) => {
      const raw = init?.body;
      sent.push(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer));
      return new Response(reply, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    onModelRequest: (sessionId, data) => records.push([sessionId, data]),
  });
}

const request = { model: "omnirush/gpt-6-mini", instructions: "You are a title generator.", input: [{ role: "user", content: [{ type: "input_text", text: CANARY }] }], stream: true };
const post = (headers: Record<string, string>) => new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
  method: "POST",
  headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", "x-omnirush-session-id": "ses_t", ...headers },
  body: JSON.stringify(request),
});

describe("title capture", () => {
  test("replyText: Responses deltas, the completed response, chat completions and plain JSON", () => {
    expect(replyText(TITLE_STREAM, "text/event-stream")).toBe("Tidy parser é \"q\"");
    expect(replyText(sse([{ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "Only done" }] }] } }]), "text/event-stream")).toBe("Only done");
    expect(replyText(`data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\ndata: [DONE]\n\n`, "text/event-stream")).toBe("A");
    expect(replyText(JSON.stringify({ output_text: "Plain" }), "application/json")).toBe("Plain");
    expect(replyText("not json", "application/json")).toBeNull();
  });

  test("a title request goes to onModelRequest verbatim, on the chat's model; other requests do not", async () => {
    const records: Array<[string, Record<string, unknown>]> = [];
    const sent: string[] = [];
    const gateway = broker(records, TITLE_STREAM, sent);
    const response = await gateway.handle(post({ "x-omnirush-title": "1", "x-omnirush-chat-model": "gpt-6-astra" }), "responses");
    // The engine gets the stream unchanged.
    expect(await response.text()).toBe(TITLE_STREAM);
    await (await gateway.handle(post({}), "responses")).text();
    expect(records).toHaveLength(1);
    const onChatModel = { ...request, model: "omnirush/gpt-6-astra" };
    expect(records[0]).toEqual(["ses_t", { schema: 1, kind: "title", route: "responses", model: "omnirush/gpt-6-astra", status: 200, request: onChatModel, text: "Tidy parser é \"q\"", completed: true }]);
    // What was recorded is what went up (the chat's model), the canary verbatim.
    expect(JSON.parse(sent[0]!).input).toEqual(onChatModel.input);
  });

  test("a title stream cut short is recorded as not completed, with what came", async () => {
    const records: Array<[string, Record<string, unknown>]> = [];
    const gateway = broker(records, sse([{ type: "response.output_text.delta", delta: "Half" }]));
    await (await gateway.handle(post({ "x-omnirush-title": "1" }), "responses")).text();
    expect(records).toHaveLength(1);
    expect(records[0]![1].text).toBe("Half");
    expect(records[0]![1].completed).toBe(false);
  });
});
