/**
 * Cronología (docs/cronologia-edades.md): the story's time per chapter and characters'
 * ages, computed, never stored. Pure and deterministic: no AI, no I/O.
 *
 * Dates are partial ("1972", "marzo de 1972"), so every point in time is a range of days.
 * A chapter's time is a mark at its start: a date, or an interval after the previous
 * chapter ("cinco años después"). A chapter without a mark inherits the previous one
 * (estimated). Before any date, the story counts from its own beginning (frame "origin"):
 * "cinco años después" still works without a calendar, but can't be compared with dates.
 */
import { chapterLabel, nameMatcher } from "./ai/context";

export type Calendar = "real" | "relative";

export interface StoryDate {
  /** 1972, or a relative year (0, 5, -20…) when the novel has no real calendar. */
  year: number;
  month?: number;
  day?: number;
}

export interface Interval {
  years?: number;
  months?: number;
  days?: number;
}

export type TimeWhen = { date: StoryDate } | { after: Interval };

/** The story's time at the start of a chapter (v1: one per chapter). */
export interface TimeMark {
  chapter_id: string;
  when: TimeWhen;
  /** On purpose earlier than the previous chapter: no warning for going back. */
  flashback: boolean;
  label: string;
}

/** What is known of a character's age: never the age itself, which is computed. */
export type AgeAnchor =
  | { kind: "birth"; date: StoryDate }
  | { kind: "age_at"; age: number; at: { chapter_id: string } | { date: StoryDate } };

export interface CharacterTime {
  id: string;
  name: string;
  aliases: string;
  age_anchor: AgeAnchor | null;
  /** "Unos cuarenta": shown with ≈, and no warnings for a year either way. */
  age_approx: boolean;
  death: StoryDate | null;
}

/** A range of days in one frame. */
export interface Point {
  frame: "calendar" | "origin";
  min: number;
  max: number;
  /** Inherited from an earlier chapter, or the story's unknown beginning. */
  estimated: boolean;
  /**
   * How the author said it: the last date written (null: the story's beginning) and the time
   * added since ("cinco años después"…). Lets "1977" be read as five years after "1972".
   */
  base?: StoryDate | null;
  since?: { months: number; days: number };
}

export interface Age {
  min: number;
  max: number;
  approx: boolean;
}

// ---------------------------------------------------------------------------
// Days (proleptic Gregorian, any year, H. Hinnant's algorithms)
// ---------------------------------------------------------------------------

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

const daysInMonth = (y: number, m: number) => daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1);

/** The days a partial date may be. */
export function dateRange(date: StoryDate): { min: number; max: number } {
  if (!date.month) return { min: daysFromCivil(date.year, 1, 1), max: daysFromCivil(date.year, 12, 31) };
  if (!date.day) return { min: daysFromCivil(date.year, date.month, 1), max: daysFromCivil(date.year, date.month, daysInMonth(date.year, date.month)) };
  return { min: daysFromCivil(date.year, date.month, date.day), max: daysFromCivil(date.year, date.month, date.day) };
}

function addInterval(day: number, iv: Interval, sign = 1): number {
  const { y, m, d } = civilFromDays(day);
  const months = y * 12 + (m - 1) + sign * ((iv.years ?? 0) * 12 + (iv.months ?? 0));
  const ny = Math.floor(months / 12);
  const nm = months - ny * 12 + 1;
  return daysFromCivil(ny, nm, Math.min(d, daysInMonth(ny, nm))) + sign * (iv.days ?? 0);
}

/** Full years from one day to another (an age). */
function yearsBetween(from: number, to: number): number {
  const a = civilFromDays(from);
  const b = civilFromDays(to);
  return b.y - a.y - (b.m < a.m || (b.m === a.m && b.d < a.d) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Validation (the API stores only what passes here)
// ---------------------------------------------------------------------------

const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function parseStoryDate(v: unknown): StoryDate | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  if (typeof v !== "object" || !int(o.year, -100000, 100000)) throw new Error("Fecha del relato inválida: falta el año.");
  const out: StoryDate = { year: o.year as number };
  if (o.month !== undefined && o.month !== null) {
    if (!int(o.month, 1, 12)) throw new Error("Mes inválido (1–12).");
    out.month = o.month as number;
    if (o.day !== undefined && o.day !== null) {
      if (!int(o.day, 1, daysInMonth(out.year, out.month))) throw new Error("Día inválido para ese mes.");
      out.day = o.day as number;
    }
  } else if (o.day !== undefined && o.day !== null) throw new Error("Un día necesita su mes.");
  return out;
}

export function parseInterval(v: unknown): Interval {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Interval = {};
  for (const k of ["years", "months", "days"] as const) {
    if (o[k] === undefined || o[k] === null || o[k] === 0) continue;
    if (!int(o[k], 0, 100000)) throw new Error("Intervalo inválido: años, meses y días son números enteros positivos.");
    out[k] = o[k] as number;
  }
  if (!out.years && !out.months && !out.days) throw new Error("Indica cuánto tiempo después.");
  return out;
}

export function parseWhen(v: unknown): TimeWhen {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.date !== undefined) return { date: parseStoryDate(o.date)! };
  if (o.after !== undefined) return { after: parseInterval(o.after) };
  throw new Error("Indica una fecha o cuánto tiempo después.");
}

/** An anchor; its chapter must be checked against the novel by the caller. */
export function parseAgeAnchor(v: unknown): AgeAnchor | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "birth") return { kind: "birth", date: parseStoryDate(o.date)! };
  if (o.kind === "age_at") {
    if (!int(o.age, 0, 200)) throw new Error("Edad inválida.");
    const at = (o.at ?? {}) as Record<string, unknown>;
    if (typeof at.chapter_id === "string") return { kind: "age_at", age: o.age as number, at: { chapter_id: at.chapter_id } };
    if (at.date !== undefined) return { kind: "age_at", age: o.age as number, at: { date: parseStoryDate(at.date)! } };
    throw new Error("Indica en qué capítulo o fecha tenía esa edad.");
  }
  throw new Error("Tipo de edad desconocido.");
}

// ---------------------------------------------------------------------------
// Timeline and ages
// ---------------------------------------------------------------------------

/** The story's time at the start of each chapter, in reading order. */
export function timeline(chapterIds: string[], marks: TimeMark[]): Point[] {
  const byChapter = new Map(marks.map((m) => [m.chapter_id, m]));
  const out: Point[] = [];
  let prev: Point = { frame: "origin", min: 0, max: 0, estimated: true, base: null, since: { months: 0, days: 0 } };
  for (const id of chapterIds) {
    const mark = byChapter.get(id);
    let point: Point;
    if (mark && "date" in mark.when)
      point = { frame: "calendar", ...dateRange(mark.when.date), estimated: false, base: mark.when.date, since: { months: 0, days: 0 } };
    else if (mark && "after" in mark.when) {
      const after = mark.when.after;
      const s = prev.since ?? { months: 0, days: 0 };
      point = {
        frame: prev.frame,
        min: addInterval(prev.min, after),
        max: addInterval(prev.max, after),
        estimated: false,
        base: prev.base,
        since: { months: s.months + (after.years ?? 0) * 12 + (after.months ?? 0), days: s.days + (after.days ?? 0) },
      };
    } else point = { ...prev, estimated: true };
    out.push(point);
    prev = point;
  }
  return out;
}

/** When a character was born, as a range in one frame; null if it can't be known. */
export function birthRange(c: Pick<CharacterTime, "age_anchor">, chapterIds: string[], points: Point[]): Point | null {
  const a = c.age_anchor;
  if (!a) return null;
  if (a.kind === "birth") return { frame: "calendar", ...dateRange(a.date), estimated: false };
  const at: Point | null =
    "chapter_id" in a.at
      ? (points[chapterIds.indexOf(a.at.chapter_id)] ?? null)
      : { frame: "calendar", ...dateRange(a.at.date), estimated: false };
  if (!at) return null;
  // Being `age` on a day means being born after age+1 years before it, and at most age years before.
  return { frame: at.frame, min: addInterval(at.min, { years: a.age + 1 }, -1) + 1, max: addInterval(at.max, { years: a.age }, -1), estimated: at.estimated };
}

/**
 * The time from one point to another as the author said it ("1972" → "1977": five years),
 * in months and days, or null when the two can't be related that way (different precision,
 * or one dated and the other not).
 */
function statedDelta(a: Point, b: Point): { months: number; days: number } | null {
  if (a.base === undefined || b.base === undefined || a.frame !== b.frame) return null;
  const sa = a.since ?? { months: 0, days: 0 };
  const sb = b.since ?? { months: 0, days: 0 };
  let months = sb.months - sa.months;
  let days = sb.days - sa.days;
  if (a.base && b.base) {
    const precision = (d: StoryDate) => (d.day ? 3 : d.month ? 2 : 1);
    if (precision(a.base) !== precision(b.base)) return null;
    months += (b.base.year - a.base.year) * 12 + ((b.base.month ?? 1) - (a.base.month ?? 1));
    days += (b.base.day ?? 1) - (a.base.day ?? 1);
  } else if (a.base || b.base) return null;
  return { months, days };
}

/** Being `age` at one moment, the age some time later (or earlier): exact for whole years. */
function ageAfter(age: number, d: { months: number; days: number }): { min: number; max: number } {
  if (d.days === 0 && d.months % 12 === 0) return { min: age + d.months / 12, max: age + d.months / 12 };
  const years = d.months / 12 + d.days / 365.2425;
  return { min: Math.floor(age + years), max: Math.ceil(age + 1 + years) - 1 };
}

export function ageAt(birth: Point | null, point: Point | null, approx = false): Age | null {
  if (!birth || !point || birth.frame !== point.frame) return null;
  const min = yearsBetween(birth.max, point.min);
  const max = yearsBetween(birth.min, point.max);
  return { min: Math.min(min, max), max: Math.max(min, max), approx };
}

export function formatAge(a: Age): string {
  if (a.approx) return `≈ ${Math.round((a.min + a.max) / 2)} años`;
  return a.min === a.max ? `${a.min} ${a.min === 1 ? "año" : "años"}` : `${a.min}–${a.max} años`;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function formatYear(y: number, calendar: Calendar) {
  return calendar === "relative" ? `Año ${y}` : y < 0 ? `${-y} a. C.` : String(y);
}

/** A point, said as precisely as it is known: "12 de marzo de 1972", "1972", "Año 5", "Inicio + 5 años". */
export function formatPoint(p: Point, calendar: Calendar): string {
  if (p.frame === "origin") {
    const a = civilFromDays(p.min);
    const b = civilFromDays(p.max);
    const span = (c: { y: number; m: number }) => {
      const parts = [c.y ? `${c.y} ${c.y === 1 ? "año" : "años"}` : "", c.m - 1 ? `${c.m - 1} ${c.m - 1 === 1 ? "mes" : "meses"}` : ""].filter(Boolean);
      return parts.length ? `Inicio + ${parts.join(" y ")}` : "Inicio de la historia";
    };
    const base = civilFromDays(0);
    return span({ y: a.y - base.y, m: a.m - base.m + 1 }) + (b.y !== a.y || b.m !== a.m ? " (aprox.)" : "");
  }
  const a = civilFromDays(p.min);
  const b = civilFromDays(p.max);
  const year = formatYear(a.y, calendar);
  if (p.min === p.max) return calendar === "relative" ? `${year}, ${a.d} de ${MONTHS[a.m - 1]}` : `${a.d} de ${MONTHS[a.m - 1]} de ${year}`;
  if (a.y === b.y && a.m === b.m) return calendar === "relative" ? `${year}, ${MONTHS[a.m - 1]}` : `${MONTHS[a.m - 1]} de ${year}`;
  if (a.y === b.y) return year;
  return `${year}–${formatYear(b.y, calendar)}`;
}

// ---------------------------------------------------------------------------
// The novel's chronology: points, ages and warnings
// ---------------------------------------------------------------------------

export interface ChronologyInput {
  calendar: Calendar;
  chapters: { id: string; title: string; content?: string }[];
  marks: TimeMark[];
  characters: CharacterTime[];
  relationships?: { from_id: string; to_id: string; kind: string }[];
}

export interface TimeWarning {
  /** Stable for one problem (a character and a rule…): what a dismissal refers to. */
  key: string;
  /** Changes when the data behind it changes: a dismissed warning comes back then. */
  fingerprint: string;
  level: "error" | "review";
  message: string;
  chapterIds: string[];
  characterIds: string[];
}

export interface Chronology {
  points: Point[];
  /** Character id → chapter index → age (null: unknown). */
  ages: Map<string, (Age | null)[]>;
  births: Map<string, Point | null>;
  warnings: TimeWarning[];
}

const list = (n: string[]) => (n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} y ${n.at(-1)}`);

export function chronology(input: ChronologyInput): Chronology {
  const ids = input.chapters.map((c) => c.id);
  const points = timeline(ids, input.marks);
  const label = (i: number) => `«${chapterLabel(i, input.chapters[i].title)}»`;
  const marks = new Map(input.marks.map((m) => [m.chapter_id, m]));
  const ages = new Map<string, (Age | null)[]>();
  const births = new Map<string, Point | null>();
  const warnings: TimeWarning[] = [];

  // Going back in time without saying it is a flashback.
  for (let i = 1; i < points.length; i++) {
    const mark = marks.get(ids[i]);
    const p = points[i];
    const q = points[i - 1];
    if (!mark || mark.flashback || p.frame !== q.frame || p.max >= q.min) continue;
    warnings.push({
      key: `regress:${ids[i]}`,
      fingerprint: `${p.min}:${p.max}:${q.min}:${q.max}`,
      level: "review",
      message: `${label(i)} (${formatPoint(p, input.calendar)}) es anterior a ${label(i - 1)} (${formatPoint(q, input.calendar)}). Si es una retrospectiva, márcalo como tal.`,
      chapterIds: [ids[i]],
      characterIds: [],
    });
  }

  for (const c of input.characters) {
    const birth = birthRange(c, ids, points);
    births.set(c.id, birth);
    const row = points.map((p) => ageOf(c, p, ids, points) ?? ageAt(birth, p, c.age_approx));
    ages.set(c.id, row);
    if (!input.chapters.some((ch) => ch.content !== undefined)) continue;
    const m = nameMatcher(c);
    const present = m ? input.chapters.map((ch, i) => (ch.content && m.test(ch.content) ? i : -1)).filter((i) => i >= 0) : [];
    const slack = c.age_approx ? 1 : 0;
    const unborn = present.filter((i) => row[i] && row[i]!.max + slack < 0);
    if (unborn.length)
      warnings.push({
        key: `unborn:${c.id}`,
        fingerprint: unborn.map((i) => `${ids[i]}:${points[i].min}:${birth?.max}`).join("|"),
        level: "error",
        message: `${c.name} aparece en ${list(unborn.map(label))}, antes de nacer.`,
        chapterIds: unborn.map((i) => ids[i]),
        characterIds: [c.id],
      });
    const old = present.filter((i) => row[i] && row[i]!.min - slack > 120);
    if (old.length)
      warnings.push({
        key: `old:${c.id}`,
        fingerprint: old.map((i) => `${ids[i]}:${row[i]!.min}`).join("|"),
        level: "error",
        message: `${c.name} tendría más de 120 años en ${list(old.map(label))}. ¿Un año mal escrito?`,
        chapterIds: old.map((i) => ids[i]),
        characterIds: [c.id],
      });
    if (c.death) {
      const death = dateRange(c.death);
      const after = present.filter((i) => points[i].frame === "calendar" && points[i].min > death.max && !marks.get(ids[i])?.flashback);
      if (after.length)
        warnings.push({
          key: `dead:${c.id}`,
          fingerprint: after.map((i) => `${ids[i]}:${points[i].min}`).join("|") + `:${death.max}`,
          level: "review",
          message: `${c.name} muere en ${formatPoint({ frame: "calendar", ...death, estimated: false }, input.calendar)} pero aparece en ${list(after.map(label))}, que no está marcado como retrospectiva.`,
          chapterIds: after.map((i) => ids[i]),
          characterIds: [c.id],
        });
    }
  }

  // Parents and children: a parent at least ~12 years older.
  const byId = new Map(input.characters.map((c) => [c.id, c]));
  for (const r of input.relationships ?? []) {
    const k = r.kind.toLowerCase();
    const parentFirst = /\b(padre|madre)\b/.test(k);
    const childFirst = /\b(hij[oa])\b/.test(k);
    if (parentFirst === childFirst) continue;
    const [parentId, childId] = parentFirst ? [r.from_id, r.to_id] : [r.to_id, r.from_id];
    const parent = births.get(parentId);
    const child = births.get(childId);
    if (!parent || !child || parent.frame !== child.frame) continue;
    const gap = yearsBetween(parent.min, child.max); // the largest possible difference
    if (gap >= 12) continue;
    const p = byId.get(parentId)!;
    const ch = byId.get(childId)!;
    warnings.push({
      key: `parent:${parentId}:${childId}`,
      fingerprint: `${parent.min}:${parent.max}:${child.min}:${child.max}`,
      level: "review",
      message:
        gap < 0
          ? `${ch.name} nace antes que ${p.name}, su ${/madre/.test(k) ? "madre" : "padre"} según las relaciones.`
          : `${p.name} tendría como mucho ${gap} años al nacer ${ch.name}.`,
      chapterIds: [],
      characterIds: [parentId, childId],
    });
  }

  return { points, ages, births, warnings };
}

/**
 * An age anchored to a chapter, read the way the author wrote the times: 21 in the chapter
 * of 1972 is 26 in the chapter of 1977, or five years later. Null when that reading
 * doesn't apply (then the age comes from the ranges of dates).
 */
export function ageOf(c: Pick<CharacterTime, "age_anchor" | "age_approx">, p: Point, chapterIds: string[], points: Point[]): Age | null {
  const a = c.age_anchor;
  if (!a || a.kind !== "age_at" || !("chapter_id" in a.at)) return null;
  const at = points[chapterIds.indexOf(a.at.chapter_id)];
  const d = at ? statedDelta(at, p) : null;
  return d ? { ...ageAfter(a.age, d), approx: c.age_approx } : null;
}

/** For the AI and the file: "26 años (21 en el capítulo 1)". */
export function describeAge(
  c: CharacterTime,
  age: Age | null,
  chapters: { id: string; title: string }[],
  calendar: Calendar,
): string | null {
  if (!age || !c.age_anchor) return null;
  const a = c.age_anchor;
  const from =
    a.kind === "birth"
      ? `nació en ${formatPoint({ frame: "calendar", ...dateRange(a.date), estimated: false }, calendar)}`
      : "chapter_id" in a.at
        ? `${a.age} en el ${chapterLabel(chapters.findIndex((ch) => ch.id === (a.at as { chapter_id: string }).chapter_id), chapters.find((ch) => ch.id === (a.at as { chapter_id: string }).chapter_id)?.title ?? "").replace(/^Capítulo/, "capítulo")}`
        : `${a.age} en ${formatPoint({ frame: "calendar", ...dateRange(a.at.date), estimated: false }, calendar)}`;
  return `${formatAge(age)} (${from})`;
}
