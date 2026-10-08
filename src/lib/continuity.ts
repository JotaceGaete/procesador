/**
 * Automatic continuity check of a proposal of the Asistente (docs/asistente-contexto.md,
 * «Continuidad»): deterministic, no AI, a few milliseconds, so it runs on every scene and
 * rewrite. It compares the proposal with what is already established and says what to look
 * at; it never blocks nor changes anything. Deliberately cautious: a warning is a «revisa»,
 * not a verdict (two people may wear different clothes; a place may only be mentioned).
 *
 *   names    a capitalised name that is neither in the Memoria nor earlier in the scene
 *   clothes  a garment that changes colour, or a different garment where one was described
 *   place    the scene is set in one place of the Memoria and the proposal sets it in another
 *   age      «Claudia, de veinte años» when the chronology says 25 at this point
 */

export interface ContinuityWarning {
  kind: "nombre" | "ropa" | "lugar" | "edad";
  message: string;
}

export interface ContinuityInput {
  /** The proposal, as it would reach the manuscript. */
  proposal: string;
  /** The text of the scene before it (from the last scene break), or the fragment it rewrites. */
  before: string;
  /** Other text the proposal may legitimately take names from (the argument of the scene, the brief). */
  given?: string;
  characters: { name: string; aliases: string }[];
  places: { name: string; aliases: string }[];
  /** The place the author chose for the scene, if any. */
  place?: { name: string; aliases: string } | null;
  /** Each character's age at this point of the story (Cronología), when known. */
  ages?: { name: string; aliases: string; min: number; max: number; approx: boolean }[];
}

const MAX_PER_KIND = 2;

/** The part of the chapter that is the current scene: after the last scene break. */
export function currentScene(text: string): string {
  const i = Math.max(text.lastIndexOf("[[separador]]"), text.lastIndexOf("* * *"));
  return i === -1 ? text : text.slice(i);
}

const norm = (s: string) =>
  s
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

function namesOf(x: { name: string; aliases: string }): string[] {
  return [x.name, ...x.aliases.split(/[,;]/)].map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Capitalised words that are not names: weekdays, months, forms of address, interjections… */
const NOT_NAMES = new Set(
  [
    "dios", "señor", "señora", "señorita", "don", "doña", "virgen", "navidad", "año nuevo", "semana santa",
    "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo",
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
    "mamá", "papá", "abuela", "abuelo", "tía", "tío", "doctor", "doctora", "padre", "madre", "hermano", "hermana",
  ].map(norm),
);

/** Capitalised words not at the start of a sentence (nor after a dialogue dash): candidate names. */
function capitalised(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<=[\p{Ll},;:]\s)([A-ZÁÉÍÓÚÑ][\p{Ll}]{2,})/gu)) out.push(m[1]);
  return out;
}

function checkNames(i: ContinuityInput): ContinuityWarning[] {
  const known = new Set(
    [...i.characters, ...i.places].flatMap(namesOf).flatMap((n) => n.split(/\s+/)).map(norm),
  );
  const earlier = norm(`${i.before}\n${i.given ?? ""}`);
  const seen = new Set<string>();
  const out: ContinuityWarning[] = [];
  for (const w of capitalised(i.proposal)) {
    const n = norm(w);
    if (seen.has(n) || known.has(n) || NOT_NAMES.has(n) || new RegExp(`(^|[^\\p{L}])${n}([^\\p{L}]|$)`, "u").test(earlier)) continue;
    seen.add(n);
    out.push({ kind: "nombre", message: `Aparece «${w}», que no está en la Memoria ni antes en la escena. ¿Es alguien nuevo?` });
    if (out.length >= MAX_PER_KIND) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clothes
// ---------------------------------------------------------------------------

/** Garments that take each other's place: a «blusa» where a «cotona» was is worth a look; shoes are not. */
const KIND_OF: Record<string, string> = Object.fromEntries(
  (
    [
      ["arriba", ["cotona", "blusa", "camisa", "camiseta", "polera", "poleron", "chaleco", "sueter", "jersey"]],
      ["encima", ["chaqueta", "parka", "abrigo", "poncho", "chal"]],
      ["cuerpo", ["vestido", "falda", "pollera", "pantalon", "pantalone", "jean", "overol", "terno", "traje", "delantal", "uniforme", "bata", "pijama"]],
    ] as const
  ).flatMap(([kind, list]) => list.map((g) => [g, kind])),
);
const GARMENTS = [
  "cotona", "blusa", "camisa", "camiseta", "polera", "polerón", "chaleco", "suéter", "jersey", "chaqueta", "parka", "abrigo",
  "vestido", "falda", "pollera", "pantalón", "pantalones", "jeans", "delantal", "uniforme", "bata", "pijama", "poncho",
  "overol", "terno", "traje", "corbata", "bufanda", "gorro", "sombrero", "zapatos", "zapatillas", "botas", "sandalias", "chal",
];
const COLORS = [
  "azul", "roja", "rojo", "verde", "amarilla", "amarillo", "negra", "negro", "blanca", "blanco", "gris", "café", "marrón",
  "rosada", "rosado", "morada", "morado", "celeste", "beige", "naranja", "granate", "burdeos", "lila", "violeta", "dorada", "dorado",
];
const GARMENT_RE = new RegExp(
  `\\b(${GARMENTS.join("|")})\\b(?:\\s+(?:de\\s+\\p{L}+\\s+)?(${COLORS.join("|")})\\b)?`,
  "giu",
);
/** Colours by their stem (azul/azules, roja/rojo…), so «roja» and «rojo» are the same. */
const colorStem = (c: string) => norm(c).replace(/(as|os|a|o|es)$/, "");
const garmentStem = (g: string) => norm(g).replace(/es$|s$/, "");

function garments(text: string): { garment: string; color: string | null; said: string }[] {
  return [...text.matchAll(GARMENT_RE)].map((m) => ({ garment: garmentStem(m[1]), color: m[2] ? colorStem(m[2]) : null, said: m[0] }));
}

function checkClothes(i: ContinuityInput): ContinuityWarning[] {
  const before = garments(i.before);
  if (!before.length) return [];
  const out: ContinuityWarning[] = [];
  for (const g of garments(i.proposal)) {
    const same = before.filter((b) => b.garment === g.garment);
    if (same.length && g.color && same.every((b) => b.color && b.color !== g.color)) {
      out.push({ kind: "ropa", message: `Antes en la escena: «${same[0].said}»; la propuesta dice «${g.said}».` });
    } else if (!same.length) {
      // A different garment of the same kind where one was described: maybe someone else, maybe a change.
      const kind = KIND_OF[g.garment];
      const prev = kind ? [...before].reverse().find((b) => KIND_OF[b.garment] === kind) : null;
      if (prev) out.push({ kind: "ropa", message: `La escena describía «${prev.said}»; la propuesta habla de «${g.said}». ¿Es de otra persona o un cambio de ropa?` });
    }
    if (out.length >= MAX_PER_KIND) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

function mentions(text: string, x: { name: string; aliases: string }): boolean {
  const t = norm(text);
  return namesOf(x).some((n) => new RegExp(`(^|[^\\p{L}])${norm(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(t));
}

function checkPlace(i: ContinuityInput): ContinuityWarning[] {
  if (!i.place || mentions(i.proposal, i.place)) return [];
  // Set in another place: «en/entró a/llegó a + another place of the Memoria».
  for (const p of i.places) {
    if (p.name === i.place.name) continue;
    for (const n of namesOf(p)) {
      const re = new RegExp(`\\b(en|entr[oó] (a|en)|lleg[oó] a|dentro de)\\s+(el |la |los |las )?${norm(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u");
      if (re.test(norm(i.proposal)))
        return [{ kind: "lugar", message: `La escena es en «${i.place.name}», pero la propuesta la sitúa en «${p.name}».` }];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Ages
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };

/** «25», «veinte», «treinta y dos»: the number, or null. */
export function spanishNumber(s: string): number | null {
  const t = norm(s.trim());
  if (/^\d{1,3}$/.test(t)) return Number(t);
  if (t in UNITS) return UNITS[t];
  const m = t.match(/^(\p{L}+)(?: y (\p{L}+))?$/u);
  if (m && m[1] in TENS) return TENS[m[1]] + (m[2] ? (UNITS[m[2]] ?? NaN) : 0) || null;
  return null;
}

function checkAges(i: ContinuityInput): ContinuityWarning[] {
  const out: ContinuityWarning[] = [];
  const sentences = i.proposal.split(/(?<=[.!?…])\s+|\n+/);
  for (const a of i.ages ?? []) {
    for (const s of sentences) {
      if (!mentions(s, a)) continue;
      // The age now, not a memory («cuando tenía veinte años», «a los veinte», «hace veinte años»).
      if (/cuando ten[ií]a|a los \p{L}+ a[ñn]os|hace \p{L}+ a[ñn]os|de joven|de ni[ñn][oa]/iu.test(s)) continue;
      for (const m of s.matchAll(/(\d{1,3}|[a-záéíóúñ]+(?: y [a-záéíóúñ]+)?) a[ñn]os/giu)) {
        const n = spanishNumber(m[1]);
        if (n == null || n < 1) continue;
        const slack = a.approx ? 1 : 0;
        if (n < a.min - slack || n > a.max + slack) {
          const age = a.min === a.max ? `${a.min}` : `entre ${a.min} y ${a.max}`;
          out.push({ kind: "edad", message: `La propuesta da a ${a.name} ${n} años; según la Cronología, en este punto tiene ${age}.` });
        }
      }
    }
    if (out.length >= MAX_PER_KIND) break;
  }
  return out.slice(0, MAX_PER_KIND);
}

/** Every warning, at most two of each kind. */
export function checkContinuity(i: ContinuityInput): ContinuityWarning[] {
  if (!i.proposal.trim()) return [];
  return [...checkNames(i), ...checkClothes(i), ...checkPlace(i), ...checkAges(i)];
}
