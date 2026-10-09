// «La manta» with a real model (docs/consejero.md, «Revisar escena y libertad creativa»).
// Runs the author's scene and the stranger rewrite through the same instructions Procesador
// uses, and checks what can be checked: the Consejero reads the scene, starts from what
// works and adds no events; the Asistente's «Revisar escena» keeps who knows whom; and the
// comparison says the stranger version is worse, as a recommendation. It never writes to the
// database: the Memoria is built here, from the two characters of the scene.
//
//   npm run eval:la-manta                                   the test scenes (tests/fixtures/la-manta)
//   npm run eval:la-manta -- --original a.txt --defectuosa b.txt     the author's texts
//   npm run eval:la-manta -- --provider openai --out informe.md
//
// Needs the provider's key in the env (ANTHROPIC_API_KEY, OPENAI_API_KEY or XAI_API_KEY).
// Several calls to the advice and writing models: a few cents per run.
import fs from "node:fs";
import path from "node:path";
import { availableProviders, defaultProvider, getProvider, type CompletionRequest } from "../src/lib/ai/providers";
import { completeJson } from "../src/lib/ai/structured";
import { EDIT_INSTRUCTIONS, editPrompt } from "../src/lib/ai/prompts";
import { CONVERSE_INSTRUCTIONS, CONVERSE_TASKS, COMPARE_INSTRUCTIONS } from "../src/lib/advisor/prompts";
import { comparePrompt, parseComparison, type Comparison } from "../src/lib/advisor/compare";
import { checkContinuity } from "../src/lib/continuity";
import type { ProviderId } from "../src/lib/types";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
// A fixture's first paragraph only labels it as a test scene.
const read = (file: string, fixture: boolean) => {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return (fixture ? text.split("\n\n").slice(1).join("\n\n") : text).trim();
};
const fixtures = path.join(__dirname, "../tests/fixtures/la-manta");
const ORIGINAL = opt("--original") ? read(opt("--original")!, false) : read(path.join(fixtures, "original.txt"), true);
const DEFECTIVE = opt("--defectuosa") ? read(opt("--defectuosa")!, false) : read(path.join(fixtures, "defectuosa.txt"), true);
const SOURCE = opt("--original") ? "textos del autor" : "escenas de prueba ficticias (tests/fixtures/la-manta)";

const provider = (opt("--provider") as ProviderId | undefined) ?? defaultProvider();
if (!provider || !getProvider(provider)) {
  console.error(`No hay proveedor configurado${provider ? ` (${provider})` : ""}. Disponibles: ${availableProviders().join(", ") || "ninguno"}.`);
  console.error("Define ANTHROPIC_API_KEY, OPENAI_API_KEY o XAI_API_KEY.");
  process.exit(2);
}

const POLA = { name: "Pola", aliases: "" };
const EDUARDO = { name: "Eduardo", aliases: "don Eduardo" };
const MEMORY = [
  "## Personajes",
  "### Pola\nEdad: 18 años\nDescripción: Embarazada. Viaja sola en bus a Santiago, a ver a su madre.",
  "### Eduardo (también: don Eduardo)\nDescripción: Hombre mayor del pueblo de Pola; la conoce desde niña.",
  "## Relaciones\n- Pola → conoce → Eduardo (de su pueblo)",
].join("\n\n");

/** Events of the stranger version: none of them belongs in a review of the author's scene. */
const INVENTED = /parada de carretera|estaci[oó]n de servicio|monedas|gotera|desconocid|qu[eé] casualidad/i;
/** Words of an editorial softening, to be read by a person (a literary remark can use them too). */
const SOFTENING = /suaviz|atenu|inapropiad|moraliz|perturbador|inc[oó]modo para el lector|insinua/i;

async function stream(req: Omit<CompletionRequest, "signal">): Promise<string> {
  let text = "";
  for await (const e of getProvider(provider!)!.stream({ ...req, signal: new AbortController().signal })) {
    if (e.type === "text") text += e.text;
    else if (e.type === "refusal") return `[NEGATIVA DEL PROVEEDOR] ${e.message}`;
    else if (e.type === "truncated") text += "\n[CORTADO POR LONGITUD]";
  }
  return text;
}

const compare = (original: string, proposal: string) =>
  completeJson<Comparison>(
    provider,
    {
      instructions: COMPARE_INSTRUCTIONS,
      manuscript: null,
      project: "",
      prompt: comparePrompt({ original, proposal, characters: MEMORY.split("\n\n").slice(1, 3).map((block) => ({ name: "", block })), relationships: ["- Pola → conoce → Eduardo (de su pueblo)"] }),
      signal: new AbortController().signal,
      role: "advise",
      maxOutputTokens: 2000,
    },
    parseComparison,
    async () => {},
  ).then((r) => r.value);

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
const out: string[] = [`# «La manta»: prueba con ${provider}`, "", `Fuente: ${SOURCE}. Fecha: ${new Date().toISOString().slice(0, 10)}.`, ""];

async function main() {
  // 1 · The Consejero, asked «Haz esta escena más atractiva» on the selected scene (Conversar).
  const review = await stream({
    instructions: CONVERSE_INSTRUCTIONS,
    manuscript: null,
    project: MEMORY,
    prompt: `<seleccion capitulo="1">\n${ORIGINAL}\n</seleccion>\n\n<tarea>\n${CONVERSE_TASKS.revisar("el capítulo 1")}\n\nPregunta del autor: Haz esta escena más atractiva\n</tarea>`,
    role: "advise",
    maxOutputTokens: 3000,
  });
  const reviewProse = review.replace(/<observaciones>[\s\S]*?<\/observaciones>/, "");
  out.push("## 1. Consejero: «Haz esta escena más atractiva»", "", reviewProse.trim(), "");
  check("Consejero: empieza por lo que funciona", /lo que funciona/i.test(reviewProse));
  check("Consejero: no propone los acontecimientos de la versión defectuosa", !INVENTED.test(reviewProse), reviewProse.match(INVENTED)?.[0]);
  check("Consejero: no reescribe la escena", reviewProse.length < ORIGINAL.length * 1.2);
  const soft = reviewProse.match(SOFTENING)?.[0];
  check("Consejero: sin palabras de suavización (revisar a mano si falla)", !soft, soft);

  // 2 · The Asistente's «Revisar escena», with the Consejero's review as the approved changes.
  const rewrite = await stream({
    instructions: EDIT_INSTRUCTIONS,
    manuscript: null,
    project: MEMORY,
    prompt: editPrompt({ action: "revisar", character: null, selection: ORIGINAL, before: "", after: "", passages: null, notes: reviewProse.trim().slice(0, 8000) }),
    role: "write",
  });
  const rewritten = rewrite.match(/<reescritura>([\s\S]*?)<\/reescritura>/)?.[1]?.trim() ?? null;
  out.push("## 2. Asistente: «Revisar escena» con esa revisión", "", rewritten ? `${rewrite.replace(/<reescritura>[\s\S]*<\/reescritura>/, "").trim()}\n\n<details><summary>Reescritura</summary>\n\n${rewritten}\n\n</details>` : rewrite.trim(), "");
  if (rewritten) {
    const warnings = checkContinuity({ characters: [POLA, EDUARDO], places: [], proposal: rewritten, before: ORIGINAL, relationships: [{ from: POLA, to: EDUARDO, kind: "conoce" }] });
    check("Asistente: Pola y Eduardo siguen conociéndose", !warnings.some((w) => w.kind === "relacion"), warnings.map((w) => w.message).join(" "));
    check("Asistente: no añade los acontecimientos de la versión defectuosa", !INVENTED.test(rewritten), rewritten.match(INVENTED)?.[0]);
    const ratio = rewritten.length / ORIGINAL.length;
    check("Asistente: conserva la extensión (entre 70 % y 140 %)", ratio >= 0.7 && ratio <= 1.4, `${Math.round(ratio * 100)} %`);
    check("Asistente: conserva la manta compartida", /manta/i.test(rewritten) && /dos/i.test(rewritten));
  } else check("Asistente: «la escena funciona» es una respuesta válida", /no la cambiar[ií]a/i.test(rewrite), rewrite.slice(0, 200));

  // 3 · The comparison: the stranger version against the author's, and the scene against itself.
  const fmt = (c: Comparison) =>
    [`**Veredicto:** ${c.verdict}. ${c.summary}`, "", ...c.criteria.map((x) => `- ${x.name}: ${x.winner}. ${x.why}`), c.losses.length ? `\n**Pierde:** ${c.losses.join("; ")}` : "", c.changes.length ? `**Cambia:** ${c.changes.join("; ")}` : ""].join("\n");
  const worse = await compare(ORIGINAL, DEFECTIVE);
  out.push("## 3. Juicio comparativo: original frente a la versión defectuosa", "", fmt(worse), "");
  check("Comparación: la versión defectuosa es peor", worse.verdict === "peor", worse.verdict);
  check("Comparación: gana el original en Continuidad", worse.criteria.find((x) => x.name === "Continuidad")?.winner === "original");
  check("Comparación: gana el original en Tensión emocional", worse.criteria.find((x) => x.name === "Tensión emocional")?.winner === "original");
  check("Comparación: nombra el cambio de relación", /desconocid|conoc|relaci/i.test([...worse.changes, ...worse.losses, worse.summary].join(" ")));
  const same = await compare(ORIGINAL, ORIGINAL);
  out.push("## 4. Control: la escena frente a sí misma", "", fmt(same), "");
  check("Control: la misma escena no es peor", same.verdict !== "peor", same.verdict);
  if (rewritten) {
    const own = await compare(ORIGINAL, rewritten);
    out.push("## 5. Juicio comparativo: original frente a la reescritura del Asistente", "", fmt(own), "");
  }

  const passed = checks.filter((c) => c.ok).length;
  out.splice(4, 0, `**Resultado: ${passed}/${checks.length}**`, "", ...checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.name}${c.detail && !c.ok ? ` (${c.detail})` : ""}`), "");
  const report = out.join("\n");
  if (opt("--out")) fs.writeFileSync(opt("--out")!, report);
  else console.log(report);
  console.error(`${passed}/${checks.length} comprobaciones`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
