// Stand-ins for the Anthropic, OpenAI and xAI streaming APIs. Used by the unit
// tests (providers) and the E2E stack. Every request body is kept in `log`.
//
// The reply depends on the request: a scene request (WRITE instructions) gets
// <escena>, anything else a <reescritura>. "REFUSE-ME" anywhere in the system
// prompt makes the provider decline.

const SCENE = "<escena>Juan dejó las llaves sobre la mesa. Elena no levantó la vista.\n\n—¿Café? —dijo él.</escena>";
const EDIT = "Bien el ritmo.\n\n<reescritura>Texto propuesto por el modelo.</reescritura>";
// "MANTEN-IMAGENES" in a request: a rewrite that keeps (and reorders) the image placeholders.
const EDIT_KEEP = "Bien.\n\n<reescritura>Primero la imagen.\n\n[IMAGEN 1]\n\nY el texto reescrito.</reescritura>";

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

/** Handles /anthropic/v1/messages, /openai/responses and /xai/chat/completions. Returns false otherwise. */
export function handleAI(req, res, body, log) {
  const path = req.url.split("?")[0];
  if (!["/anthropic/v1/messages", "/openai/responses", "/xai/chat/completions"].includes(path)) return false;
  const json = body ? JSON.parse(body) : {};

  if (path === "/anthropic/v1/messages") {
    log.push({ provider: "anthropic", body: json });
    const system = JSON.stringify(json.system ?? "");
    const text = system.includes("<escena>") ? SCENE : body.includes("MANTEN-IMAGENES") ? EDIT_KEEP : EDIT;
    sse(res, [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: json.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: system.includes("REFUSE-ME") ? "refusal" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
    return true;
  }

  if (path === "/openai/responses") {
    log.push({ provider: "openai", body: json });
    const instructions = json.instructions ?? "";
    const text = instructions.includes("<escena>") ? SCENE : body.includes("MANTEN-IMAGENES") ? EDIT_KEEP : EDIT;
    const half = Math.floor(text.length / 2);
    let n = 0;
    const refuse = instructions.includes("REFUSE-ME");
    sse(res, [
      ["response.created", { type: "response.created", sequence_number: n++, response: { id: "r", status: "in_progress" } }],
      ...(refuse
        ? [
            [
              "response.refusal.delta",
              {
                type: "response.refusal.delta",
                sequence_number: n++,
                item_id: "i",
                output_index: 0,
                content_index: 0,
                delta: "No.",
              },
            ],
          ]
        : [
            [
              "response.output_text.delta",
              {
                type: "response.output_text.delta",
                sequence_number: n++,
                item_id: "i",
                output_index: 0,
                content_index: 0,
                delta: text.slice(0, half),
              },
            ],
            [
              "response.output_text.delta",
              {
                type: "response.output_text.delta",
                sequence_number: n++,
                item_id: "i",
                output_index: 0,
                content_index: 0,
                delta: text.slice(half),
              },
            ],
          ]),
      ["response.completed", { type: "response.completed", sequence_number: n++, response: { id: "r", status: "completed" } }],
    ]);
    return true;
  }

  log.push({ provider: "xai", body: json });
  const system = json.messages?.[0]?.content ?? "";
  if (req.headers.authorization !== "Bearer test-x") {
    res.writeHead(401);
    res.end("{}");
    return true;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const finish = system.includes("REFUSE-ME") ? "content_filter" : "stop";
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: system.includes("<escena>") ? SCENE : EDIT }, finish_reason: finish }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
  return true;
}
