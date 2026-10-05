/**
 * Comparing two versions of a chapter (docs/versiones.md): what was removed and what was
 * added, word by word inside the paragraphs that changed. Paragraphs first, so a long
 * chapter with a few edits stays fast; a block too different to compare word by word is
 * shown as removed and added whole.
 */

export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/** Above this many differing tokens in one block, compare no further: removed and added whole. */
const MAX_EDITS = 4000;

/** Myers' diff over tokens. Null when the two differ by more than `maxEdits`. */
function myers(a: string[], b: string[], maxEdits: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      y--;
      ops.push({ kind: "same", text: a[--x] });
    }
    if (x === prevX) ops.push({ kind: "add", text: b[--y] });
    else ops.push({ kind: "del", text: a[--x] });
  }
  while (x > 0 && y > 0) {
    y--;
    ops.push({ kind: "same", text: a[--x] });
  }
  return ops.reverse();
}

/**
 * For a reader, not a machine: a change whose words only share the spaces between them
 * («~~La~~ Texto ~~casa~~ propuesto…») reads as one change, what goes and what comes. Runs
 * of changes separated only by blank space or punctuation become one removed and one
 * added block. Both texts can still be rebuilt from the result.
 */
function readable(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  const glue = (o: DiffOp) => o.kind === "same" && /^[\s.,;:!?¡¿«»"'—–-]*$/.test(o.text);
  for (let i = 0; i < ops.length; ) {
    if (ops[i].kind === "same") {
      out.push(ops[i++]);
      continue;
    }
    // A run of changes, with the glue between them (never at its ends).
    let j = i;
    let end = i;
    while (j < ops.length && (ops[j].kind !== "same" || glue(ops[j]))) {
      if (ops[j].kind !== "same") end = j;
      j++;
    }
    const run = ops.slice(i, end + 1);
    const del = run.filter((o) => o.kind !== "add").map((o) => o.text).join("");
    const add = run.filter((o) => o.kind !== "del").map((o) => o.text).join("");
    if (del) out.push({ kind: "del", text: del });
    if (add) out.push({ kind: "add", text: add });
    i = end + 1;
  }
  return out;
}

/** Joins consecutive operations of the same kind. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (!op.text) continue;
    const last = out.at(-1);
    if (last && last.kind === op.kind) last.text += op.text;
    else out.push({ ...op });
  }
  return out;
}

const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const words = (t: string) => t.match(/\s+|[^\s]+/g) ?? [];

/** Common start and end, compared apart: most edits touch a small part of the text. */
function trimmed(a: string[], b: string[], inner: (a: string[], b: string[]) => DiffOp[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [
    { kind: "same", text: a.slice(0, start).join("") },
    ...inner(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    { kind: "same", text: a.slice(a.length - end).join("") },
  ];
}

const whole = (a: string[], b: string[]): DiffOp[] => [
  { kind: "del", text: a.join("") },
  { kind: "add", text: b.join("") },
];

/** The differences between an earlier text and a later one. */
export function diffText(before: string, after: string): DiffOp[] {
  const ops = trimmed(lines(before), lines(after), (a, b) => {
    const byLine = myers(a, b, MAX_EDITS);
    if (!byLine) return whole(a, b);
    // Each run of removed lines followed by added ones: compared word by word.
    const out: DiffOp[] = [];
    for (let i = 0; i < byLine.length; ) {
      if (byLine[i].kind === "same") {
        out.push(byLine[i++]);
        continue;
      }
      const del: string[] = [];
      const add: string[] = [];
      while (i < byLine.length && byLine[i].kind !== "same") (byLine[i].kind === "del" ? del : add).push(byLine[i++].text);
      if (!del.length || !add.length) {
        out.push(...del.map((text) => ({ kind: "del" as const, text })), ...add.map((text) => ({ kind: "add" as const, text })));
        continue;
      }
      out.push(...trimmed(words(del.join("")), words(add.join("")), (x, y) => myers(x, y, MAX_EDITS) ?? whole(x, y)));
    }
    return out;
  });
  return merge(readable(merge(ops)));
}

/** Words removed and added, for a one-line summary. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  const count = (kind: DiffOp["kind"]) =>
    ops.filter((o) => o.kind === kind).reduce((n, o) => n + (o.text.match(/\S+/g)?.length ?? 0), 0);
  return { added: count("add"), removed: count("del") };
}
