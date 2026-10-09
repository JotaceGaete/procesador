#!/usr/bin/env node
// Ensayo de la migración conjunta de bloqueo y reserva sobre una COPIA de la base real
// (docs/integracion-bloqueo-reserva.md). Nunca se conecta a Supabase: sólo lee el respaldo.
//
//   node scripts/ensayo-migracion.mjs procesador-antes.dump
//
// Levanta un PostgreSQL temporal en este ordenador, restaura el respaldo (pg_dump -Fc o .sql),
// y comprueba, en este orden:
//   1. el respaldo se restaura entero; su huella (supabase/huella.sql) es la que se imprime, para
//      compararla con la que dio la base real en el SQL Editor (si es igual, el respaldo sirve);
//   2. la base es la del Crítico (verificar.sql pide justo lo de bloqueo y reserva, nada más);
//   3. actualizar-bloqueo-reserva.sql se aplica dos veces, como en el SQL Editor, sin errores;
//   4. verificar.sql ya no pide nada; la huella es la misma (salvo la línea de títulos, que
//      cambia sólo si había títulos con «Capítulo N»: se listan);
//   5. deshacer-bloqueo-reserva.sql deja la huella igual, y la migración se vuelve a aplicar.
// Requiere los binarios de PostgreSQL (initdb, pg_ctl, psql, pg_restore; PG_BIN si no se encuentran).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dump = process.argv[2];
if (!dump || !fs.existsSync(dump)) {
  console.error("Uso: node scripts/ensayo-migracion.mjs <respaldo.dump | respaldo.sql>");
  process.exit(2);
}

function findPgBin() {
  const c = [process.env.PG_BIN];
  if (fs.existsSync("/usr/lib/postgresql"))
    for (const v of fs.readdirSync("/usr/lib/postgresql").sort().reverse()) c.push(`/usr/lib/postgresql/${v}/bin`);
  c.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  const found = c.find((d) => d && fs.existsSync(path.join(d, "initdb")));
  if (!found) throw new Error("No se encontró PostgreSQL (initdb). Instálalo o define PG_BIN.");
  return found;
}
const bin = findPgBin();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "procesador-ensayo-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const asPostgres = (tool, args) => {
  const full = path.join(bin, tool);
  if (process.getuid?.() === 0) {
    const q = [full, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    return execFileSync("su", ["postgres", "-s", "/bin/sh", "-c", q], { stdio: "pipe" });
  }
  return execFileSync(full, args, { stdio: "pipe" });
};
// UTC and ISO dates, like Supabase: the huella depends on how timestamps print.
const env = { ...process.env, PGTZ: "UTC", PGDATESTYLE: "ISO, MDY", PGOPTIONS: "--client-min-messages=warning" };
function sql(text, { db = "ensayo", file = false } = {}) {
  const base = ["-h", dir, "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  const f = path.join(dir, "script.sql");
  if (file) fs.writeFileSync(f, text);
  const r = spawnSync(path.join(bin, "psql"), file ? [...base, "-f", f] : [...base, "-c", text], { env, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return r.stdout.trim();
}
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failed = true;
};

try {
  if (process.getuid?.() === 0) execFileSync("chown", ["-R", "postgres", dir]);
  fs.chmodSync(dir, 0o777);
  asPostgres("initdb", ["-D", path.join(dir, "data"), "-A", "trust", "-U", "postgres", "--no-sync"]);
  asPostgres("pg_ctl", ["-D", path.join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", path.join(dir, "log"), "-w", "start"]);
  sql("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;", { db: "postgres" });
  sql("create database ensayo", { db: "postgres" });

  // 1. Restore.
  const head = fs.readFileSync(dump).subarray(0, 5).toString();
  if (head === "PGDMP") {
    const r = spawnSync(path.join(bin, "pg_restore"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "ensayo", "--no-owner", "--no-privileges", "-n", "public", dump], { env, encoding: "utf8" });
    // pg_restore reports what it can't recreate (Supabase's own roles, extensions): shown, not fatal.
    if (r.status !== 0) console.log(`(pg_restore avisó)\n${r.stderr.trim().split("\n").slice(0, 10).join("\n")}`);
  } else sql(fs.readFileSync(dump, "utf8"), { file: true });
  sql("grant usage on schema public to anon, authenticated, service_role; grant execute on all functions in schema public to service_role;");
  const HUELLA = read("supabase/huella.sql");
  const before = sql(HUELLA);
  console.log("\nHuella del respaldo restaurado (compárala con la de supabase/huella.sql en el SQL Editor):\n" + before + "\n");
  check(/^chapters\|\d+ filas/m.test(before), "respaldo restaurado, con capítulos");

  // 2. The schema version.
  const missing = sql(read("supabase/verificar.sql")).split("\n").filter(Boolean);
  const expected = /chapters\.(locked|locked_at|reserved)|chapter_versions\.reserved|guard_locked|create_chapter|move_chapter|anterior al bloqueo|anterior a los capítulos en reserva/;
  check(missing.length > 0 && missing.every((l) => expected.test(l)), `la base es la del Crítico (falta sólo bloqueo y reserva: ${missing.length} elementos)`);
  if (missing.some((l) => !expected.test(l))) console.log("  Falta además:\n  " + missing.filter((l) => !expected.test(l)).join("\n  "));
  const titles = sql("select string_agg(id || ' ' || title, E'\\n' order by id) from chapters");

  // 3–4. The migration, twice, like the SQL Editor (one query).
  const MIGRATION = read("supabase/actualizar-bloqueo-reserva.sql");
  sql(MIGRATION);
  sql(MIGRATION);
  check(sql(read("supabase/verificar.sql")) === "", "migración aplicada dos veces; verificar.sql no pide nada");
  const after = sql(HUELLA);
  const changed = before.split("\n").filter((l) => !after.split("\n").includes(l)).map((l) => l.split("|")[0]);
  check(changed.every((t) => t === "chapters.title"), `datos intactos${changed.length ? " (salvo títulos con «Capítulo N»)" : ""}`);
  const now = new Map(sql("select id, title from chapters").split("\n").filter(Boolean).map((l) => l.split("|")));
  const stripped = titles.split("\n").filter(Boolean).map((l) => [l.slice(0, 36), l.slice(37)]).filter(([id, t]) => now.get(id) !== t);
  if (stripped.length) console.log(`  Títulos que pierden el número guardado (${stripped.length}):\n` + stripped.map(([id, t]) => `  ${id}  «${t}» → «${now.get(id)}»`).join("\n"));
  check(sql("select count(*) from chapters where locked or reserved") === "0", "todos los capítulos en el manuscrito y desbloqueados");

  // 5. Recovery, and forward again.
  sql(read("supabase/deshacer-bloqueo-reserva.sql"));
  const undone = sql(HUELLA);
  check(undone.split("\n").filter((l) => !before.split("\n").includes(l)).every((l) => l.startsWith("chapters.title|")), "deshacer-bloqueo-reserva.sql deja los datos como estaban");
  sql(MIGRATION);
  check(sql(read("supabase/verificar.sql")) === "", "la migración se vuelve a aplicar después de deshacerla");
} catch (e) {
  check(false, e.message);
} finally {
  try {
    asPostgres("pg_ctl", ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "\nEl ensayo FALLÓ: no apliques la migración en producción." : "\nEnsayo correcto.");
process.exit(failed ? 1 : 0);
