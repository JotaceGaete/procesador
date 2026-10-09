// Stand-ins for the Anthropic, OpenAI and xAI streaming APIs. Used by the unit
// tests (providers) and the E2E stack. Every request body is kept in `log`.
//
// The reply depends on the request: a scene request (WRITE instructions) gets
// <escena>, anything else a <reescritura>. "REFUSE-ME" anywhere in the system
// prompt makes the provider decline.

const SCENE = "<escena>Juan dejó las llaves sobre la mesa. Elena no levantó la vista.\n\n—¿Café? —dijo él.</escena>";
// A developed scene (~700 words, with dialogue): asked to widen a draft (<borrador>), or
// "ESCENA-LARGA" in the argument. Any other scene request gets the short SCENE.
const LONG_SCENE = (tag) =>
  `<escena>${tag}. ${Array.from({ length: 45 }, (_, i) => `Juan cruzó la cocina despacio, paso ${i + 1}, sin mirarla.\n\n—¿Vas a seguir callada? —preguntó él.`).join("\n\n")}</escena>`;
// "ESCENA-FORMATO" in the argument: a scene with italics, a scene break and bold, as models write them.
const FORMAT_SCENE = "<escena>Leyó *Rayuela* de un tirón.\n\n* * *\n\nAl día siguiente dijo **nunca**.</escena>";
// Continuity hooks in the argument: "ESCENA-ROPA" changes the garment and brings in a new
// name; "ESCENA-EDAD" gives Claudia an age the chronology contradicts.
// "ESCENA-CONTRADICE" in the argument: only the <aviso> (no scene) until the author confirms the change.
const sceneReply = (prompt) =>
  prompt.includes("ESCENA-CONTRADICE") && !prompt.includes("El autor ya confirmó el cambio")
    ? "<aviso>El argumento presenta a Eduardo como un desconocido, y Pola y Eduardo se conocen.</aviso>"
    : prompt.includes("ESCENA-ROPA")
    ? "<escena>Marcela se ajustó la blusa roja frente al espejo. En el pasillo, Rodrigo esperaba sin decir nada.</escena>"
    : prompt.includes("ESCENA-EDAD")
      ? "<escena>Claudia, que tenía veinte años, cerró la ventana.</escena>"
      : prompt.includes("<borrador>")
    ? LONG_SCENE("ESCENA-AMPLIADA")
    : prompt.includes("ESCENA-LARGA")
      ? LONG_SCENE("ESCENA-DESARROLLADA")
      : prompt.includes("ESCENA-FORMATO")
        ? FORMAT_SCENE
        : SCENE;
const EDIT = "Bien el ritmo.\n\n<reescritura>Texto propuesto por el modelo.</reescritura>";
// "MANTEN-IMAGENES" in a request: a rewrite that keeps (and reorders) the image placeholders.
const EDIT_KEEP = "Bien.\n\n<reescritura>Primero la imagen.\n\n[IMAGEN 1]\n\nY el texto reescrito.</reescritura>";
// "MANTEN-FORMATO" in a request: a rewrite that keeps the italics and the scene break (as * * *).
const EDIT_FORMAT = "Bien.\n\n<reescritura>*Uno* reescrito.\n\n* * *\n\nDos reescrito.</reescritura>";
// "REESCRIBE-DESCONOCIDO" in a request: a rewrite that makes a stranger of an acquaintance («La manta»).
const EDIT_STRANGER = "Así quedaría.\n\n<reescritura>En la parada de carretera, un desconocido ayudó a Pola con las monedas. Se llamaba Eduardo.</reescritura>";
const editReply = (body) =>
  body.includes("REESCRIBE-DESCONOCIDO") ? EDIT_STRANGER : body.includes("MANTEN-IMAGENES") ? EDIT_KEEP : body.includes("MANTEN-FORMATO") ? EDIT_FORMAT : EDIT;

/**
 * The Consejero's reading (structured JSON). Built from the request itself, so quotes are
 * real: the first words of the chapter. Hooks in the chapter text:
 *   "CABO: <título>"      opens a thread (or advances it if it exists)
 *   "CIERRA: <título>"    closes it
 *   "CITA-INVENTADA"      adds an event whose quote is not in the text
 *   "JSON-ROTO"           the first answer is not JSON (the retry is fine)
 *   "JSON-SIEMPRE-ROTO"   never valid
 */
function readingReply(system, user) {
  // Juicio comparativo: a proposal that turns an acquaintance into a stranger is worse.
  if (system.includes("<juicio-comparativo>")) {
    const proposal = (user.match(/<propuesta>\n([\s\S]*?)\n<\/propuesta>/) ?? [])[1] ?? "";
    const worse = /desconocid/i.test(proposal);
    const criteria = ["Tensión emocional", "Subtexto", "Ritmo", "Naturalidad", "Caracterización", "Continuidad", "Fuerza del desenlace"].map((name) => ({
      name,
      winner: worse ? "original" : "empate",
      why: worse ? "El original conserva el reconocimiento." : "Sin diferencias claras.",
    }));
    return JSON.stringify({
      verdict: user.includes("JUICIO-ROTO") ? "quizá" : worse ? "peor" : "igual",
      summary: worse ? "Conserva tu versión: la propuesta convierte a Eduardo en un desconocido." : "Las dos versiones funcionan parecido.",
      criteria,
      losses: worse ? ["El reconocimiento entre Pola y Eduardo"] : [],
      changes: worse ? ["Pola y Eduardo se conocen; la propuesta los hace desconocidos"] : [],
    });
  }
  if (system.includes("<resumen-conversacion>")) {
    const n = (user.match(/^\[(Autor|Consejero)\]/gm) ?? []).length;
    return JSON.stringify({ summary: `Resumen de la conversación: ${n} mensajes anteriores.` });
  }
  // «Enviar al Asistente»: the brief, from the chosen proposal and the author's plan.
  // "ENCARGO-ROTO" in the proposal: never valid JSON (the server falls back to the proposal).
  if (system.includes("<encargo-escena>")) {
    const chosen = (user.match(/<propuesta-elegida etiqueta="[^"]*">\n([^\n]*)\n([^\n]*)/) ?? []).slice(1);
    if (user.includes("ENCARGO-ROTO")) return "Esto no es JSON.";
    const block = (title) => {
      const m = user.match(new RegExp(`${title}[^\\n]*:\\n((?:- [^\\n]*\\n?)+)`));
      return m ? m[1].trim().split("\n").map((l) => l.slice(2)) : [];
    };
    const people = [...(user.match(/<personajes>\n([\s\S]*?)\n<\/personajes>/)?.[1] ?? "").matchAll(/^- ([^(\n]+)/gm)].map((m) => m[1].trim());
    const text = chosen.join(" ");
    return JSON.stringify({
      argument: `Escena: ${chosen[0] ?? "?"}. ${chosen[1] ?? ""}`.trim(),
      decisions: block("Decisiones del autor"),
      constraints: ["No revelar todavía el misterio."],
      discarded: block("Descartado por el autor"),
      characters: people.filter((n) => text.includes(n)),
      place: "",
    });
  }
  if (system.includes("<resumen-global>")) {
    const n = (user.match(/<ficha /g) ?? []).length;
    return JSON.stringify({ summary: `Resumen global a partir de ${n} fichas de capítulo, con sus cabos.` });
  }
  if (!system.includes("<ficha-capitulo>")) return null;
  const retry = user.includes("no era válida");
  if (user.includes("JSON-SIEMPRE-ROTO") || (user.includes("JSON-ROTO") && !retry)) return "Esto no es JSON.";
  const text = (user.match(/<capitulo titulo="[^"]*">\n([\s\S]*?)\n<\/capitulo>/) ?? [])[1] ?? "";
  const people = [...user.matchAll(/^- \[([^\]]+)\] ([^(\n]+)/gm)].map((m) => ({ id: m[1], name: m[2].trim() }));
  const section = (tag) => (user.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`)) ?? [])[1] ?? "";
  const threads = [...section("cabos").matchAll(/^- \[([^\]]+)\] (.+?) · /gm)].map((m) => ({ id: m[1], title: m[2] }));
  const characters = people.filter((p) => section("personajes").includes(p.id) && text.toLowerCase().includes(p.name.toLowerCase()));
  const first = text.split(/(?<=[.!?])\s/)[0];
  const quote = first.split(/\s+/).slice(0, 8).join(" ").replace(/[.,;:!?]+$/, "");
  const events = [{ text: `Sucede: ${first}`, characters: characters.map((c) => c.id), quote }];
  if (text.includes("CITA-INVENTADA")) events.push({ text: "Algo dudoso", characters: [], quote: "esta cita no aparece en el capítulo" });
  const changes = [];
  for (const [, verb, title] of text.matchAll(/(CABO|CIERRA): ([^.\n]+)/g)) {
    // Like a model would: a thread renamed by the author is still recognised.
    const known = threads.find((t) => title.trim().startsWith(t.title) || t.title.startsWith(title.trim()));
    changes.push({
      thread: known?.id ?? null,
      title: title.trim(),
      kind: "mystery",
      change: verb === "CIERRA" ? "closed" : known ? "advanced" : "opened",
      quote: `${verb}: ${title.trim()}`,
    });
  }
  return JSON.stringify({
    summary: `Resumen del capítulo: ${text.split(/\s+/).slice(0, 30).join(" ")}`,
    events,
    presence: characters.map((c) => ({ character: c.id, kind: "present" })),
    revelations: [],
    threads: changes,
    notes: "Escena con diálogo.",
  });
}

/**
 * The Consejero's answer: Markdown, then <observaciones> with one card quoting the open
 * chapter, one with an invented quote, one attributed to the wrong chapter, and for
 * "¿Cómo seguir?" three alternatives. "OBS-ROTAS" in the request breaks the JSON.
 */
function adviceReply(system, user) {
  if (!system.includes("<consejero>")) return null;
  // Lectura profunda hooks, in the author's question:
  //   PEDIR: [..]           first round asks for this
  //   PEDIR2: [..]          second round asks for this
  //   PEDIR-SIEMPRE: [..]   asks every time it is allowed to
  //   TEXTO-ANTES           writes a sentence before the request (taken back by the server)
  const question = (user.match(/Pregunta del autor: ([^\n]*)/) ?? [])[1] ?? "";
  const rounds = (user.match(/<material ronda=/g) ?? []).length;
  const last = user.includes("Ya no puedes pedir más material");
  const hook = (name) => (question.match(new RegExp(`${name}: (\\[.*?\\])(?= [A-Z]|$)`)) ?? [])[1];
  const wanted = !last && (hook("PEDIR-SIEMPRE") ?? (rounds === 0 ? hook("PEDIR") : rounds === 1 ? hook("PEDIR2") : null));
  if (wanted && system.includes("<lectura-profunda>")) {
    return `${question.includes("TEXTO-ANTES") ? "Déjame revisar antes un capítulo. " : ""}<solicitar>\n${wanted}\n</solicitar>`;
  }
  const m = user.match(/<capitulo-actual numero="(\d+)"[^>]*>\n([\s\S]*?)\n<\/capitulo-actual>/);
  const n = m ? Number(m[1]) : 1;
  const text = m ? m[2] : "";
  const quote = text.split(/(?<=[.!?])\s/)[0].split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
  const task = (user.match(/<tarea>\n([^\n]+)/) ?? [])[1] ?? "";
  const cards = [
    { kind: "pacing", title: "Arranque lento", body: "El capítulo tarda en entrar en conflicto.", confidence: "medium", refs: [{ chapter: n, quote }] },
    { kind: "problem", title: "Una impresión", body: "Algo no termina de encajar.", confidence: "high", refs: [{ chapter: n, quote: "una cita que el modelo inventó" }] },
    { kind: "opportunity", title: "Mal atribuida", body: "Cita del capítulo abierto, con otro número.", confidence: "low", refs: [{ chapter: n === 1 ? 2 : 1, quote }] },
  ];
  // With material: a card that connects what it read, quoting it.
  if (rounds) {
    const refs = [];
    for (const m of user.matchAll(/\[Capítulo (\d+)[^\]]*\]\n([^\n]+)/g)) refs.push({ chapter: Number(m[1]), quote: m[2].split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "") });
    for (const m of user.matchAll(/<capitulo numero="(\d+)"[^>]*>\n([^\n]+)/g)) refs.push({ chapter: Number(m[1]), quote: m[2].split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "") });
    cards.push({ kind: "contradiction", title: "Lo leído en profundidad", body: `Conecta ${refs.length} pasajes de ${rounds} rondas.`, confidence: "high", refs: refs.slice(0, 4).concat([{ chapter: n, quote }]) });
  }
  if (last && question.includes("PEDIR-SIEMPRE")) {
    return `<solicitar>\n${hook("PEDIR-SIEMPRE")}\n</solicitar>`;
  }
  if (task.includes("Revisa los cabos")) {
    cards.push({ kind: "thread", title: "La carta de Marta sigue abierta", body: "No aparece desde hace tiempo.", confidence: "medium", refs: [] });
    cards.push({ kind: "thread", title: "El viaje a Cartagena", body: "Se insinúa y no se retoma.", confidence: "low", refs: [] });
  }
  // Consejero creativo: only proposals, in sections, built from what the request carries
  // (the people of the memory block, the secrets of the data, the proposal in course).
  const people = [...user.matchAll(/^### ([^\n(]+)/gm)].map((m) => m[1].trim());
  const secret = (user.match(/^- ([^:\n]+): secretos: ([^.\n]+)/m) ?? []).slice(1);
  const proposal = (title, extra = {}) => ({
    kind: "alternative",
    title,
    body: "",
    ocurre: `${title}: qué podría ocurrir.`,
    porque: "Porque continúa lo que ya está en juego.",
    aprovecha: secret.length ? `El secreto de ${secret[0]}: ${secret[1]}` : "El final del capítulo.",
    consecuencias: "Cambia lo que sabe cada uno.",
    riesgos: "Puede adelantar demasiado.",
    personajes: people.join(", "),
    confidence: "medium",
    refs: [{ chapter: n, quote }],
    ...extra,
  });
  // Revisar escena (both modes): strengths first; the scene works, so nothing is proposed.
  if (task.startsWith("El autor quiere mejorar una escena")) {
    const scene = (user.match(/<seleccion capitulo="\d+">\n([\s\S]*?)\n<\/seleccion>/) ?? [])[1] ?? text;
    const first = scene.split(/(?<=[.!?])\s/)[0].split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
    return `**Lo que funciona:** «${first}».\n\n**Veredicto:** La escena funciona; no la cambiaría.\n\n<observaciones>\n[]\n</observaciones>`;
  }
  // Conversar: a short answer and, at most, one proposal (three when the author asked for options).
  if (system.includes("Modo: conversar.")) {
    const anchored = task.match(/(?:seguir con la propuesta|hablando de la propuesta) (\S+) \(«([^»]*)»/);
    const say = (title, body) => ({ kind: "alternative", title, body, personajes: people, confidence: "medium", refs: [{ chapter: n, quote }] });
    let ideas = [];
    if (task.includes("Propón 2 o 3 direcciones")) ideas = ["Una cena en casa", "Una llamada", "Un viaje"].map((t) => say(t, `${t}: qué ocurriría.`));
    else if (anchored) ideas = [say(`${anchored[2]} — ${question.slice(0, 60)}`, `Desarrollo de ${anchored[1]}: ${question}`)];
    else if (/Propón UNA? |Señala UNA/.test(task)) ideas = [say("Una escena cotidiana", "Yo continuaría con una escena cotidiana en casa, sin resolver todavía el misterio.")];
    const reply = `Yo lo haría así: ${task.split(".")[0]}.`;
    return ideas.length ? `${reply}\n\n<observaciones>\n${JSON.stringify(ideas)}\n</observaciones>` : reply;
  }
  const anchorTask = task.match(/sigue con la propuesta (\S+) \(«([^»]*)»\)/);
  let creative = null;
  if (/Propón exactamente 3 direcciones|Recomienda el camino que tú seguirías/.test(task)) creative = ["Seguir el conflicto", "Recuperar un cabo", "Cambiar de personaje"].map((t) => proposal(t));
  else if (task.includes("necesita un giro")) creative = ["Giro: el secreto sale", "Giro: un testigo", "Giro: la carta"].map((t) => proposal(t));
  else if (task.includes("subir la tensión")) creative = ["Un plazo", "Alguien sabe"].map((t) => proposal(t));
  else if (task.includes("Busca oportunidades")) creative = ["Un secreto sin usar", "Una relación sin escenas", "Un cabo olvidado"].map((t) => proposal(t, { kind: "opportunity" }));
  else if (task.includes("qué pasaría si")) {
    creative = [
      { kind: "contradiction", title: "Choca con lo escrito", body: "Contradice un pasaje.", confidence: "medium", refs: [{ chapter: n, quote }] },
      proposal("Lo que abre", { kind: "opportunity" }),
      { kind: "problem", title: "Riesgo", body: `Afecta a ${people.join(", ") || "nadie"}.`, confidence: "low", refs: [] },
    ];
  } else if (anchorTask) creative = [proposal(`${anchorTask[2]} — ${question.slice(0, 60)}`)];
  else if (task.startsWith("Responde al último mensaje")) creative = [];
  if (creative) cards.splice(0, cards.length, ...creative);
  const json = user.includes("OBS-ROTAS") ? "[{ roto" : JSON.stringify(cards, null, 1);
  return `## Lectura del Consejero\n\n${task.split(":")[0]}.\n\n<observaciones>\n${json}\n</observaciones>`;
}

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
    const text =
      readingReply((json.system ?? []).map?.((b) => b.text).join("\n") ?? String(json.system ?? ""), json.messages?.[0]?.content ?? "") ??
      adviceReply((json.system ?? []).map?.((b) => b.text).join("\n") ?? "", json.messages?.[0]?.content ?? "") ??
      (system.includes("<escena>") ? sceneReply(String(json.messages?.[0]?.content ?? "")) : editReply(body));
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
            // A cached prefix: 1000 tokens read from cache, 200 fresh.
            usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 0 },
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
          usage: { output_tokens: 30 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
    return true;
  }

  if (path === "/openai/responses") {
    log.push({ provider: "openai", body: json });
    const instructions = json.instructions ?? "";
    const text =
      readingReply(instructions, String(json.input ?? "")) ??
      adviceReply(instructions, String(json.input ?? "")) ??
      (instructions.includes("<escena>") ? sceneReply(String(json.input ?? "")) : editReply(body));
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
      [
        "response.completed",
        {
          type: "response.completed",
          sequence_number: n++,
          response: {
            id: "r",
            status: "completed",
            usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 30, total_tokens: 1230 },
          },
        },
      ],
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
    `data: ${JSON.stringify({ choices: [{ delta: { content: readingReply(system, json.messages?.[1]?.content ?? "") ?? adviceReply(system, json.messages?.[1]?.content ?? "") ?? (system.includes("<escena>") ? sceneReply(json.messages?.[1]?.content ?? "") : EDIT) }, finish_reason: finish }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
  return true;
}
