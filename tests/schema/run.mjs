#!/usr/bin/env node
// Upgrading an existing database (npm run test:schema).
//
// supabase/schema.sql must run COMPLETE over any real state of a database, and again,
// without errors and without touching its data. Each scenario gets its own database in a
// throwaway PostgreSQL. Every script is run in the two ways it reaches Postgres:
//   - "editor": the whole file as ONE query, like Supabase's SQL Editor (one transaction);
//   - "psql":   statement by statement, like `psql -f` or the Supabase CLI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SCHEMA = read("supabase/schema.sql");
const MIGRATION = read("supabase/actualizar-consejero.sql");
const PLOT_MIGRATION = read("supabase/actualizar-argumento.sql");
const CRITIC_MIGRATION = read("supabase/actualizar-critico.sql");
// Bloqueo de capítulos y capítulos en reserva: una sola migración (docs/integracion-bloqueo-reserva.md).
const JOINT_MIGRATION = read("supabase/actualizar-bloqueo-reserva.sql");
const LOCK_MIGRATION = JOINT_MIGRATION;
const RESERVE_MIGRATION = JOINT_MIGRATION;
const VERIFY = read("supabase/verificar.sql");
const OLD = {
  "2b": read("tests/schema/fixtures/schema-2b.sql"),
  fase1: read("tests/schema/fixtures/schema-fase1.sql"),
  fase4: read("tests/schema/fixtures/schema-fase4.sql"),
  critico: read("tests/schema/fixtures/schema-critico.sql"),
};
const TABLES = [
  "novels", "chapters", "characters", "relationships", "places", "facts", "fact_characters", "assets",
  "character_images", "manuscript_images", "ai_usage", "story_threads", "chapter_digests", "novel_digests",
  "advisor_conversations", "advisor_messages", "advisor_observations", "chapter_versions", "time_marks",
  "chapter_critiques",
];
/** What only schema.sql brings (versions and trash), not actualizar-consejero.sql. */
const AFTER_CONSEJERO =
  /chapter_versions|save_chapter_version|trash_chapter|chapter_trash|restore_chapter|chapter_version_auto|chapters_version|time_marks|novels\.calendar|dismissed_warnings|age_anchor|age_approx|characters\.death|anterior a la cronología|novels\.book|anterior a la exportación|novels\.plot|chapter_critiques|ai_usage\.purpose|chapters\.reserved|chapter_versions\.reserved|create_chapter|move_chapter|capítulos en reserva|chapters\.locked|chapter_guard_locked|chapters_guard_locked|anterior al bloqueo/;

let bin, dir, port;

function findPgBin() {
  const c = [process.env.PG_BIN];
  if (fs.existsSync("/usr/lib/postgresql"))
    for (const v of fs.readdirSync("/usr/lib/postgresql").sort().reverse()) c.push(`/usr/lib/postgresql/${v}/bin`);
  c.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  const found = c.find((d) => d && fs.existsSync(path.join(d, "initdb")));
  if (!found) throw new Error("No se encontró PostgreSQL (initdb). Instálalo o define PG_BIN.");
  return found;
}
function asPostgres(tool, args) {
  const full = path.join(bin, tool);
  if (process.getuid?.() === 0) {
    const q = [full, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    return execFileSync("su", ["postgres", "-s", "/bin/sh", "-c", q], { stdio: "pipe" });
  }
  return execFileSync(full, args, { stdio: "pipe" });
}

/** Runs SQL; returns { ok, error }. */
function run(db, sql, mode = "editor") {
  const file = path.join(dir, "script.sql");
  fs.writeFileSync(file, sql);
  fs.chmodSync(file, 0o644);
  const base = ["-h", dir, "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  // -c sends the whole text as one query (one implicit transaction), as the SQL Editor does.
  const args = mode === "editor" ? [...base, "-c", sql] : [...base, "-f", file];
  const r = spawnSync(path.join(bin, "psql"), args, { env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" }, encoding: "utf8", maxBuffer: 1 << 26 });
  return { ok: r.status === 0, error: r.stderr.trim(), out: r.stdout.trim() };
}
const must = (db, sql, mode) => {
  const r = run(db, sql, mode);
  assert.ok(r.ok, r.error);
  return r.out;
};

let n = 0;
function newDb() {
  const db = `s${++n}`;
  must("postgres", `create database ${db}`);
  must(db, "grant usage on schema public to anon, authenticated, service_role;");
  return db;
}

/** A novel with everything a writer has before the update. */
const DATA = `
insert into novels (id, title, synopsis, guide) values ('11111111-1111-4111-8111-111111111111', 'Mi novela', 'Sinopsis', '{"tone":"seco"}');
insert into chapters (id, novel_id, title, position, content) values
  ('22222222-2222-4222-8222-222222222221', '11111111-1111-4111-8111-111111111111', 'Uno', 1, 'Texto del uno.'),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Dos', 2, 'Texto del dos.');
update chapters set content = 'Texto del uno, corregido.' where id = '22222222-2222-4222-8222-222222222221';
insert into characters (id, novel_id, name) values ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Elena');
insert into facts (novel_id, text, chapter_id) values ('11111111-1111-4111-8111-111111111111', 'Un hecho', '22222222-2222-4222-8222-222222222221');
insert into assets (id, novel_id, status, file_name, original_path, original_type, original_bytes, width, height, sha256, display_path, thumb_path, derived_type)
  values ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'ready', 'a.png', 'x/y/o', 'image/png', 10, 100, 100, 'abc', 'x/y/d', 'x/y/t', 'image/webp');
insert into character_images (novel_id, character_id, asset_id, caption) values ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'pie');
insert into manuscript_images (novel_id, asset_id, chapter_id, alt) values ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'alt');
`;

/** A fingerprint of every row of every existing table, over the columns it has now. */
function fingerprint(db) {
  const tables = must(db, "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1").split("\n").filter(Boolean);
  const out = {};
  for (const t of tables) {
    const cols = must(db, `select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${t}'`);
    out[t] = must(db, `select count(*) || ':' || coalesce(md5(string_agg(r::text, '|' order by r::text)), '') from (select ${cols} from public.${t}) r`);
    out[`${t}#cols`] = cols;
  }
  return out;
}
/** The old fingerprint must survive: same rows over the columns the table had before. */
function assertDataKept(db, beforeFp) {
  for (const [key, value] of Object.entries(beforeFp)) {
    if (key.endsWith("#cols")) continue;
    const cols = beforeFp[`${key}#cols`];
    const now = must(db, `select count(*) || ':' || coalesce(md5(string_agg(r::text, '|' order by r::text)), '') from (select ${cols} from public.${key}) r`);
    assert.equal(now, value, `datos de ${key} intactos`);
  }
}
/**
 * Up to date: the verification query returns nothing, and the app's core actions work.
 * `consejeroOnly`: after actualizar-consejero.sql, only what came later may be missing.
 */
function assertComplete(db, { consejeroOnly = false } = {}) {
  const missing = must(db, VERIFY).split("\n").filter(Boolean);
  assert.deepEqual(consejeroOnly ? missing.filter((l) => !AFTER_CONSEJERO.test(l)) : missing, [], "verificar.sql: nada falta");
  for (const t of consejeroOnly ? TABLES.filter((t) => !AFTER_CONSEJERO.test(t)) : TABLES) {
    assert.equal(must(db, `select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), "t", `${t} con RLS`);
    assert.equal(must(db, `select has_table_privilege('anon', 'public.${t}', 'select')`), "f", `${t} cerrada a anon`);
  }
  for (const t of ["novels", "story_threads", "chapter_digests", "novel_digests", "advisor_conversations", "advisor_observations"])
    assert.equal(must(db, `select count(*) from pg_trigger where tgname = '${t}_touch'`), "1", `${t}_touch`);
  assert.equal(must(db, "select count(*) from pg_trigger where tgname = 'chapters_touch'"), "1");
  if (!consejeroOnly) assert.equal(must(db, "select count(*) from pg_trigger where tgname = 'chapters_version'"), "1");
  assert.equal(must(db, "select count(*) from information_schema.columns where table_name = 'novels' and column_name = 'auto_digest'"), "1");
}

before(() => {
  bin = findPgBin();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "procesador-schema-"));
  if (process.getuid?.() === 0) execFileSync("chown", ["-R", "postgres", dir]);
  fs.chmodSync(dir, 0o777);
  port = 20000 + Math.floor(Math.random() * 20000);
  asPostgres("initdb", ["-D", path.join(dir, "data"), "-A", "trust", "-U", "postgres", "--no-sync"]);
  asPostgres("pg_ctl", ["-D", path.join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", path.join(dir, "log"), "-w", "start"]);
  // The roles Supabase provides.
  must("postgres", "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
});
after(() => {
  try {
    asPostgres("pg_ctl", ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The reported failure, as a regression test
// ---------------------------------------------------------------------------

test("regression: story_threads missing when the touch-trigger block is reached", () => {
  // A database before the Consejero, and a run that reaches the triggers without having run
  // the table section (what Supabase executes when only part of the file is selected).
  const fromTriggers = (sql) => sql.slice(sql.indexOf("-- Triggers\n") - 80);
  const old = newDb();
  must(old, OLD["2b"], "psql");
  const r = run(old, fromTriggers(OLD.fase4));
  assert.ok(!r.ok);
  assert.match(r.error, /relation "public\.story_threads" does not exist/, "the old schema reproduces the error");

  const db = newDb();
  must(db, OLD["2b"], "psql");
  must(db, DATA, "psql");
  const before = fingerprint(db);
  const partial = run(db, fromTriggers(SCHEMA));
  assert.doesNotMatch(partial.error, /story_threads" does not exist/, "no longer the cryptic error");
  assert.match(partial.error, /Esquema incompleto: falta o no está protegida: .*story_threads/, "a clear message instead");
  assertDataKept(db, before);
  assert.equal(must(db, "select count(*) from pg_proc where proname = 'duplicate_novel' and prosrc like '%auto_digest%'"), "0", "nothing applied halfway");
  // And the complete file, right after, works.
  must(db, SCHEMA);
  assertComplete(db);
  assertDataKept(db, before);
});

test("static: no statement refers to a table before the statement that guarantees it exists", () => {
  // The first-stage cleanup at the top only inspects information_schema and drops legacy tables.
  for (const [name, sql] of [["schema.sql", SCHEMA], ["actualizar-consejero.sql", MIGRATION]]) {
    const body = sql
      .slice(sql.indexOf("-- Utilidades del esquema") === -1 ? 0 : sql.indexOf("-- Utilidades del esquema"))
      .replace(/--[^\n]*/g, "");
    for (const t of TABLES) {
      const created = body.indexOf(`create table if not exists public.${t} (`);
      if (created === -1) continue; // an older table the migration doesn't create (it already exists)
      const first = body.search(new RegExp(`public\\.${t}\\b`));
      assert.equal(first, created + "create table if not exists ".length, `${name}: public.${t} aparece antes de su create table`);
      // Its protection comes right after it, before any other table is created.
      const secured = body.indexOf(`procesador_secure_table('public.${t}'`);
      assert.ok(secured > created, `${name}: ${t} protegida`);
      const nextCreate = body.indexOf("create table if not exists", created + 10);
      assert.ok(nextCreate === -1 || secured < nextCreate, `${name}: ${t} protegida antes de la siguiente tabla`);
    }
    assert.doesNotMatch(body, /foreach t in array/, `${name}: sin bucles sobre listas de tablas`);
  }
});

// ---------------------------------------------------------------------------
// Every starting state, both ways of running, twice
// ---------------------------------------------------------------------------

const STATES = {
  "vacía (instalación nueva)": () => {},
  "anterior al Consejero (2b)": (db) => {
    must(db, OLD["2b"], "psql");
    must(db, DATA, "psql");
  },
  "Consejero fase 1": (db) => {
    must(db, OLD.fase1, "psql");
    must(db, DATA, "psql");
    must(db, "insert into ai_usage (novel_id, purpose, provider, model) values ('11111111-1111-4111-8111-111111111111', 'assist', 'anthropic', 'm')", "psql");
  },
  "parcialmente actualizada a mano": (db) => {
    must(db, OLD["2b"], "psql");
    must(db, DATA, "psql");
    // Some of the new pieces, without their triggers, RLS or indexes, as a manual attempt leaves them.
    must(db, `alter table novels add column auto_digest boolean not null default false;
              update novels set auto_digest = false;
              ${SCHEMA.slice(SCHEMA.indexOf("create table if not exists public.story_threads ("), SCHEMA.indexOf("create index if not exists story_threads_novel_idx"))}
              insert into story_threads (novel_id, title) values ('11111111-1111-4111-8111-111111111111', 'Un cabo');`, "psql");
  },
  "completamente actualizada (fases 2–4, con los bucles antiguos)": (db) => {
    must(db, OLD.fase4, "psql");
    must(db, DATA, "psql");
  },
};

for (const [state, prepare] of Object.entries(STATES)) {
  for (const mode of ["editor", "psql"]) {
    test(`schema.sql completo · base ${state} · ${mode}, dos veces`, () => {
      const db = newDb();
      prepare(db);
      const before = fingerprint(db);
      must(db, SCHEMA, mode);
      assertComplete(db);
      assertDataKept(db, before);
      must(db, SCHEMA, mode);
      assertComplete(db);
      assertDataKept(db, before);
      if (state.startsWith("parcialmente")) {
        assert.equal(must(db, "select auto_digest from novels"), "f", "an existing value is never reset");
        assert.equal(must(db, "select title from story_threads"), "Un cabo");
      }
      // The app's duplicate still works on what was there.
      if (before.novels) assert.ok(must(db, "select public.duplicate_novel('11111111-1111-4111-8111-111111111111', 'Copia')"));
    });
  }
}

for (const state of ["anterior al Consejero (2b)", "Consejero fase 1", "parcialmente actualizada a mano", "completamente actualizada (fases 2–4, con los bucles antiguos)"]) {
  test(`actualizar-consejero.sql · base ${state}, dos veces; después schema.sql`, () => {
    const db = newDb();
    STATES[state](db);
    const before = fingerprint(db);
    must(db, MIGRATION);
    must(db, MIGRATION);
    assertComplete(db, { consejeroOnly: true });
    assertDataKept(db, before);
    must(db, SCHEMA);
    assertComplete(db);
    assertDataKept(db, before);
  });
}

test("an unrelated table called projects survives", () => {
  const db = newDb();
  must(db, OLD["2b"], "psql");
  must(db, "create table public.projects (id int primary key, name text); insert into public.projects values (1, 'ajeno');", "psql");
  must(db, SCHEMA);
  assert.equal(must(db, "select name from public.projects"), "ajeno");
});

// ---------------------------------------------------------------------------
// Versiones y papelera (docs/versiones.md)
// ---------------------------------------------------------------------------

test("versions: an automatic copy of the previous text at most every 30 minutes, never of an empty text", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const ch = "22222222-2222-4222-8222-222222222221";
  const count = () => Number(must(db, `select count(*) from chapter_versions where chapter_id = '${ch}' and reason = 'auto'`));
  // DATA's update happened with the schema in place: the text before it is the first copy.
  assert.equal(count(), 1);
  assert.equal(must(db, `select content from chapter_versions where chapter_id = '${ch}'`), "Texto del uno.");
  must(db, `update chapters set content = 'Otra cosa.' where id = '${ch}'`);
  assert.equal(count(), 1, "a recent copy exists: no new one");
  must(db, `update chapter_versions set created_at = now() - interval '31 minutes' where chapter_id = '${ch}'`);
  must(db, `update chapters set content = 'Y otra.' where id = '${ch}'`);
  assert.equal(count(), 2, "half an hour later, a new one");
  assert.equal(must(db, `select content from chapter_versions where chapter_id = '${ch}' order by created_at desc limit 1`), "Otra cosa.");
  // Reordering or renaming is not an edit of the text.
  must(db, `update chapter_versions set created_at = now() - interval '31 minutes' where chapter_id = '${ch}'`);
  must(db, `update chapters set title = 'Nuevo', position = 9 where id = '${ch}'`);
  assert.equal(count(), 2);
  // A chapter that starts empty leaves no empty version.
  const empty = must(db, "insert into chapters (novel_id, title, position) values ('11111111-1111-4111-8111-111111111111', 'Vacío', 3) returning id");
  must(db, `update chapters set content = 'Primeras palabras.' where id = '${empty}'`);
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id = '${empty}'`), "0");
});

test("versions: saved on demand, identical ones not repeated (except the author's), at most 100 automatic ones", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const ch = "22222222-2222-4222-8222-222222222222";
  const save = (reason, label = "", content = null) =>
    must(db, `select public.save_chapter_version('${ch}', '${reason}', '${label}', ${content === null ? "null" : `'${content}'`})`);
  const a = save("ai");
  assert.equal(save("ai"), a, "the same text again: the same version");
  assert.notEqual(save("manual", "Primer borrador"), a, "the author's own always counts");
  assert.equal(must(db, `select label from chapter_versions where reason = 'manual'`), "Primer borrador");
  assert.equal(save("ai", "", ""), "", "an empty text is not saved");
  for (let i = 0; i < 105; i++) save("ai", "", `Texto ${i}`);
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id = '${ch}' and reason <> 'manual'`), "100");
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id = '${ch}' and reason = 'manual'`), "1", "never pruned");
  assert.equal(must(db, `select words from chapter_versions where content = 'Texto 104'`), "2");
});

test("trash: deleting keeps the text and the history; restoring brings both back; 30 days later it is gone", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const novel = "11111111-1111-4111-8111-111111111111";
  const ch = "22222222-2222-4222-8222-222222222221";
  must(db, `select public.save_chapter_version('${ch}', 'manual', 'Antes de cortar')`);
  must(db, `select public.trash_chapter('${ch}')`);
  assert.equal(must(db, `select count(*) from chapters where id = '${ch}'`), "0");
  const trash = must(db, `select source_chapter_id || '|' || title || '|' || versions from public.chapter_trash('${novel}')`);
  assert.equal(trash, `${ch}|Uno|3`, "one entry, with its three versions (auto, manual, delete)");
  // The last chapter can't go.
  const r = run(db, `select public.trash_chapter('22222222-2222-4222-8222-222222222222')`);
  assert.ok(!r.ok && /al menos un capítulo/.test(r.error));

  const restored = must(db, `select public.restore_chapter('${novel}', '${ch}')`);
  assert.equal(must(db, `select title || '|' || content || '|' || position from chapters where id = '${restored}'`), "Uno|Texto del uno, corregido.|3");
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id = '${restored}'`), "3", "its history came back");
  assert.equal(must(db, `select count(*) from public.chapter_trash('${novel}')`), "0");
  assert.ok(!run(db, `select public.restore_chapter('${novel}', '${ch}')`).ok, "not twice");

  // Deleted again, and forgotten for a month.
  must(db, `select public.trash_chapter('${restored}')`);
  assert.equal(must(db, `select count(*) from public.chapter_trash('${novel}')`), "1", "one entry, not two");
  must(db, `update chapter_versions set created_at = now() - interval '31 days' where chapter_id is null`);
  assert.equal(must(db, `select count(*) from public.chapter_trash('${novel}')`), "0");
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id is null`), "0", "emptied");
});

test("versions: duplicating a novel copies no versions and rewriting its markers leaves none", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const mimg = must(db, "select id from manuscript_images limit 1");
  must(db, `update chapters set content = 'Con imagen.' || chr(10) || '[[imagen:${mimg}]]' where id = '22222222-2222-4222-8222-222222222222'`);
  const before = must(db, "select count(*) from chapter_versions");
  must(db, "select public.duplicate_novel('11111111-1111-4111-8111-111111111111', 'Copia')");
  assert.ok(must(db, "select id from novels where title = 'Copia'"));
  assert.match(must(db, "select content from chapters c join novels n on n.id = c.novel_id where n.title = 'Copia' and c.title = 'Dos'"), /\[\[imagen:/);
  assert.equal(must(db, "select count(*) from chapter_versions"), before);
});

test("word_count: separators don't count, like images", () => {
  const db = newDb();
  must(db, SCHEMA);
  assert.equal(must(db, "select public.word_count('Uno dos.' || chr(10) || '[[separador]]' || chr(10) || 'Tres.')"), "3");
});

// ---------------------------------------------------------------------------
// Cronología (docs/cronologia-edades.md)
// ---------------------------------------------------------------------------

test("cronología: una marca por capítulo, calendario válido, y duplicar copia marcas y anclas en sus capítulos nuevos", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const novel = "11111111-1111-4111-8111-111111111111";
  const ch1 = "22222222-2222-4222-8222-222222222221";
  must(db, `insert into time_marks (novel_id, chapter_id, "when") values ('${novel}', '${ch1}', '{"date":{"year":1972}}')`);
  assert.ok(!run(db, `insert into time_marks (novel_id, chapter_id, "when") values ('${novel}', '${ch1}', '{"date":{"year":1973}}')`).ok, "one per chapter");
  assert.ok(!run(db, `update novels set calendar = 'lunar'`).ok, "real or relative");
  must(db, `update novels set calendar = 'relative'`);
  must(db, `update characters set age_anchor = '{"kind":"age_at","age":21,"at":{"chapter_id":"${ch1}"}}', age_approx = true, death = '{"year":1990}'`);

  must(db, `select public.duplicate_novel('${novel}', 'Copia')`);
  const copy = must(db, "select id from novels where title = 'Copia'");
  assert.equal(must(db, `select calendar from novels where id = '${copy}'`), "relative");
  const copyCh1 = must(db, `select id from chapters where novel_id = '${copy}' and title = 'Uno'`);
  assert.equal(must(db, `select "when"->'date'->>'year' from time_marks where chapter_id = '${copyCh1}'`), "1972");
  assert.equal(must(db, `select age_anchor #>> '{at,chapter_id}' from characters where novel_id = '${copy}'`), copyCh1, "the anchor points to the copy's chapter");
  assert.equal(must(db, `select age_approx::text || ' ' || (death->>'year') from characters where novel_id = '${copy}'`), "true 1990");
  // Deleting a chapter takes its mark with it.
  must(db, `select public.trash_chapter('${ch1}')`);
  assert.equal(must(db, `select count(*) from time_marks where novel_id = '${novel}'`), "0");
});

test("exportación: los datos del libro se copian al duplicar, con la portada apuntando al archivo de la copia", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const novel = "11111111-1111-4111-8111-111111111111";
  const asset = "44444444-4444-4444-8444-444444444444";
  assert.equal(must(db, `select book::text from novels where id = '${novel}'`), "{}", "empty by default");
  must(db, `update novels set book = '{"author":"Ana Pérez","isbn":"9788437604947","coverAssetId":"${asset}"}'`);
  must(db, `select public.duplicate_novel('${novel}', 'Copia')`);
  const copy = must(db, "select id from novels where title = 'Copia'");
  const copyAsset = must(db, `select id from assets where novel_id = '${copy}'`);
  assert.notEqual(copyAsset, asset);
  assert.equal(must(db, `select book->>'author' || ' ' || (book->>'isbn') from novels where id = '${copy}'`), "Ana Pérez 9788437604947");
  assert.equal(must(db, `select book->>'coverAssetId' from novels where id = '${copy}'`), copyAsset, "the copy's file, not the original's");
  // A cover that isn't a (ready) file of the novel is dropped in the copy.
  must(db, `update novels set book = '{"coverAssetId":"55555555-5555-4555-8555-555555555555"}' where id = '${novel}'`);
  must(db, `select public.duplicate_novel('${novel}', 'Copia 2')`);
  assert.equal(must(db, "select coalesce(book->>'coverAssetId', 'null') from novels where title = 'Copia 2'"), "null");
});

test("argumento general: actualizar-argumento.sql adds novels.plot (empty), twice, without touching data; the duplicate still works", () => {
  for (const state of ["completamente actualizada (fases 2–4, con los bucles antiguos)", "Consejero fase 1"]) {
    const db = newDb();
    STATES[state](db);
    must(db, SCHEMA.replace(/alter table public\.novels add column if not exists plot[^;]*;/, ""));
    const before = fingerprint(db);
    assert.equal(must(db, "select count(*) from information_schema.columns where table_name = 'novels' and column_name = 'plot'"), "0", "the base before");
    const title = must(db, "select coalesce(string_agg(title || synopsis, '|' order by id), '') from novels");
    must(db, PLOT_MIGRATION);
    must(db, PLOT_MIGRATION);
    assertComplete(db);
    assertDataKept(db, before);
    assert.equal(must(db, "select coalesce(string_agg(title || synopsis, '|' order by id), '') from novels"), title, "nothing else changes");
    assert.equal(must(db, "select count(*) from novels where plot <> ''"), "0", "empty for every novel");
    assert.equal(must(db, "select is_nullable || ' ' || data_type from information_schema.columns where table_name = 'novels' and column_name = 'plot'"), "NO text");
    if (before.novels) assert.ok(must(db, "select public.duplicate_novel('11111111-1111-4111-8111-111111111111', 'Copia')"));
    assert.ok(!run(db, "update novels set plot = null").ok, "never null");
  }
});

test("crítico literario: actualizar-critico.sql adds chapter_critiques and the 'critic' usage, twice, without touching data", () => {
  // schema.sql as it was before the Crítico: without its block, its table in the final check, nor 'critic' in ai_usage.
  const start = SCHEMA.indexOf("-- Crítico Literario (docs/critico.md)");
  const end = SCHEMA.indexOf("end $$;", start) + "end $$;".length;
  const before = SCHEMA.slice(0, start) + SCHEMA.slice(end);
  const old = before
    .replace(", 'chapter_critiques']) as t", "]) as t")
    .replace("check (purpose in ('assist', 'advise', 'digest', 'critic'))", "check (purpose in ('assist', 'advise', 'digest'))");
  const code = old.replace(/--[^\n]*/g, "");
  assert.ok(start > 0 && !code.includes("chapter_critiques") && !code.includes("'critic'"), "the old schema has no trace of the Crítico");
  for (const state of ["completamente actualizada (fases 2–4, con los bucles antiguos)", "vacía (instalación nueva)"]) {
    const db = newDb();
    STATES[state](db);
    must(db, old);
    const critic = "select count(*) from pg_constraint where conname = 'ai_usage_purpose_check' and pg_get_constraintdef(oid) like '%critic%'";
    assert.equal(must(db, critic), "0", "the base before has no 'critic' usage");
    const fp = fingerprint(db);
    must(db, CRITIC_MIGRATION);
    must(db, CRITIC_MIGRATION, "psql");
    assertComplete(db);
    assertDataKept(db, fp);
    assert.equal(must(db, "select count(*) from pg_trigger where tgname = 'chapter_critiques_touch'"), "1");
    assert.equal(must(db, critic), "1");
    // And schema.sql over it is still a no-op for its data.
    must(db, SCHEMA);
    assertComplete(db);
    assertDataKept(db, fp);
  }
});

// ---------------------------------------------------------------------------
// Capítulos en reserva (docs/capitulos-reserva.md)
// ---------------------------------------------------------------------------

const NOVEL = "11111111-1111-4111-8111-111111111111";
/** The novel's chapters as "title:position" per group, in order. */
const groups = (db, novel = NOVEL) => ({
  main: must(db, `select coalesce(string_agg(title, ',' order by position, created_at), '') from chapters where novel_id = '${novel}' and not reserved`),
  reserve: must(db, `select coalesce(string_agg(title, ',' order by position, created_at), '') from chapters where novel_id = '${novel}' and reserved`),
  positions: must(db, `select string_agg(position::text, ',' order by reserved, position) from chapters where novel_id = '${novel}'`),
});
/** A novel of five chapters (A–E) with text, an image and versions, on the current schema. */
function reserveDb() {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  must(db, `update chapters set title = 'A' where position = 1; update chapters set title = 'B' where position = 2;`);
  for (const [t, p] of [["C", 3], ["D", 4], ["E", 5]])
    must(db, `insert into chapters (novel_id, title, position, content) values ('${NOVEL}', '${t}', ${p}, 'Texto de ${t}.')`);
  return db;
}
const id = (db, title) => must(db, `select id from chapters where title = '${title}'`);
const move = (db, title, reserved, at) => must(db, `select public.move_chapter('${id(db, title)}', ${reserved}, ${at === null ? "null" : at})`);

test("reserva: the migration over the production base (Crítico) adds the groups, keeps ids, text and order, and only strips stored numbers from titles", () => {
  for (const mode of ["editor", "psql"]) {
    const db = newDb();
    must(db, OLD.critico, "psql");
    must(db, DATA, "psql");
    must(db, `insert into chapters (id, novel_id, title, position, content) values
      ('22222222-2222-4222-8222-222222222223', '${NOVEL}', 'Capítulo 3', 3, 'Tres.'),
      ('22222222-2222-4222-8222-222222222224', '${NOVEL}', 'CAPÍTULO 4: La manta', 4, 'Cuatro.'),
      ('22222222-2222-4222-8222-222222222225', '${NOVEL}', 'Capítulo 5 - El tren', 5, 'Cinco.'),
      ('22222222-2222-4222-8222-222222222226', '${NOVEL}', 'Capítulos perdidos', 6, 'Seis.'),
      ('22222222-2222-4222-8222-222222222227', '${NOVEL}', 'Capítulo 7 La espera', 7, 'Siete.')`, "psql");
    const ids = must(db, "select string_agg(id::text || ':' || position || ':' || md5(content), ',' order by id) from chapters");
    const missing = must(db, VERIFY);
    assert.match(missing, /chapters\.reserved/, "verificar.sql sees what is missing");
    must(db, RESERVE_MIGRATION, mode);
    must(db, RESERVE_MIGRATION, mode);
    assertComplete(db);
    assert.equal(must(db, "select string_agg(id::text || ':' || position || ':' || md5(content), ',' order by id) from chapters"), ids, "ids, order and text kept");
    assert.equal(must(db, "select count(*) from chapters where reserved"), "0", "everything stays in the manuscript");
    assert.equal(
      must(db, "select string_agg(title, '|' order by position) from chapters"),
      "Uno|Dos||La manta|El tren|Capítulos perdidos|Capítulo 7 La espera",
      "only the number the app stored is removed",
    );
    // Run again after the author titles a chapter «Capítulo 3: …» on purpose: it is left alone.
    must(db, "update chapters set title = 'Capítulo 3: Prólogo' where position = 3");
    must(db, RESERVE_MIGRATION, mode);
    assert.equal(must(db, "select title from chapters where position = 3"), "Capítulo 3: Prólogo");
    // The old app keeps working on the new base: its outline call and its reorder.
    assert.match(must(db, `select string_agg(title, ',') from public.novel_outline('${NOVEL}')`), /Uno,Dos/);
    must(db, `select public.reorder_chapters('${NOVEL}', (select array_agg(id order by position desc) from chapters))`);
    assert.ok(must(db, "select public.duplicate_novel('11111111-1111-4111-8111-111111111111', 'Copia')"));
    // And schema.sql over it is a no-op.
    const fp = fingerprint(db);
    must(db, SCHEMA);
    assertComplete(db);
    assertDataKept(db, fp);
  }
});

test("reserva: the migration's functions are exactly schema.sql's", () => {
  const fns = (sql) => Object.fromEntries([...sql.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\$\$;\n/g)].map((m) => [m[1], m[0]]));
  const mine = fns(RESERVE_MIGRATION);
  const all = fns(SCHEMA);
  assert.equal(Object.keys(mine).length, 9);
  for (const [name, body] of Object.entries(mine)) assert.equal(body, all[name], `${name} igual en los dos archivos`);
});

test("reserva: create a chapter anywhere in either group; each group numbered 1…n", () => {
  const db = reserveDb();
  must(db, `select public.create_chapter('${NOVEL}', 'Entre B y C', false, 3)`);
  must(db, `select public.create_chapter('${NOVEL}', 'Al principio', false, 1)`);
  must(db, `select public.create_chapter('${NOVEL}', 'Al final', false, null)`);
  must(db, `select public.create_chapter('${NOVEL}', 'R1', true, null)`);
  must(db, `select public.create_chapter('${NOVEL}', 'R0', true, 1)`);
  must(db, `select public.create_chapter('${NOVEL}', 'Lejos', false, 999)`);
  const g = groups(db);
  assert.equal(g.main, "Al principio,A,B,Entre B y C,C,D,E,Al final,Lejos");
  assert.equal(g.reserve, "R0,R1");
  assert.equal(g.positions, "1,2,3,4,5,6,7,8,9,1,2");
  assert.equal(must(db, `select title from chapters where title = '  ' or title = ''`), "", "no number in any title");
  assert.ok(!run(db, `select public.create_chapter('99999999-9999-4999-8999-999999999999', 'x', false, null)`).ok);
});

test("reserva: reorder (arrows, drag and drop) and move between groups keep text, images, versions and ids", () => {
  const db = reserveDb();
  const mimg = must(db, "select id from manuscript_images limit 1");
  must(db, `update chapters set content = 'Con imagen.' || chr(10) || '[[imagen:${mimg}]]' where title = 'B'`);
  must(db, `select public.save_chapter_version('${id(db, "B")}', 'manual', 'Mía')`);
  const before = must(db, "select string_agg(id::text || md5(content) || revision, ',' order by id) from chapters");
  const versions = must(db, "select count(*) from chapter_versions");

  move(db, "D", false, 2); // up, by drag and drop
  assert.equal(groups(db).main, "A,D,B,C,E");
  move(db, "A", false, 2); // down one (the arrow)
  assert.equal(groups(db).main, "D,A,B,C,E");
  move(db, "B", true, null); // to the reserve
  move(db, "E", true, 1); // to the reserve, first
  let g = groups(db);
  assert.equal(g.main, "D,A,C");
  assert.equal(g.reserve, "E,B");
  assert.equal(g.positions, "1,2,3,1,2");
  move(db, "B", false, 2); // into the manuscript, between D and A
  g = groups(db);
  assert.equal(g.main, "D,B,A,C");
  assert.equal(g.reserve, "E");
  assert.equal(g.positions, "1,2,3,4,1");
  move(db, "C", false, null); // already last: nothing changes
  assert.equal(groups(db).main, "D,B,A,C");

  assert.equal(must(db, "select string_agg(id::text || md5(content) || revision, ',' order by id) from chapters"), before, "ids, text and revisions intact");
  assert.equal(must(db, "select count(*) from chapter_versions"), versions, "moving leaves no version");
  assert.equal(must(db, `select chapter_id from manuscript_images where id = '${mimg}'`), id(db, "B"), "its image is still in it");
});

test("reserva: the manuscript keeps a chapter; deleting and restoring keep the group", () => {
  const db = reserveDb();
  for (const t of ["B", "C", "D", "E"]) move(db, t, true, null);
  const r = run(db, `select public.move_chapter('${id(db, "A")}', true, null)`);
  assert.ok(!r.ok && /al menos un capítulo/.test(r.error), "the last one can't go to the reserve");
  assert.ok(!run(db, `select public.trash_chapter('${id(db, "A")}')`).ok, "nor to the trash");
  // A chapter in reserve can always be deleted, and comes back to the reserve.
  const e = id(db, "E");
  must(db, `select public.trash_chapter('${e}')`);
  const back = must(db, `select public.restore_chapter('${NOVEL}', '${e}')`);
  assert.equal(must(db, `select reserved::text || ':' || position from chapters where id = '${back}'`), "true:4", "back in the reserve, at its end");
  assert.equal(groups(db).main, "A", "never into the manuscript");
  // One from the manuscript comes back to the manuscript.
  move(db, "B", false, null);
  const b = id(db, "B");
  must(db, `select public.trash_chapter('${b}')`);
  const b2 = must(db, `select public.restore_chapter('${NOVEL}', '${b}')`);
  assert.equal(must(db, `select reserved::text || ':' || position from chapters where id = '${b2}'`), "false:2");
});

test("reserva: two moves at once are applied one after the other (no duplicate or lost position)", async () => {
  const db = reserveDb();
  const { spawn } = await import("node:child_process");
  const go = (sql) =>
    new Promise((resolve) => {
      const p = spawn(path.join(bin, "psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
      p.on("exit", resolve);
    });
  // The first holds the novel's lock for a moment; the second waits for it.
  await Promise.all([
    go(`begin; select public.move_chapter('${id(db, "A")}', true, null); select pg_sleep(0.5); commit;`),
    go(`select pg_sleep(0.1); select public.move_chapter('${id(db, "E")}', false, 1);`),
    go(`select pg_sleep(0.15); select public.create_chapter('${NOVEL}', 'Nuevo', false, 2);`),
  ]);
  const g = groups(db);
  assert.equal(g.reserve, "A");
  assert.equal(g.main, "E,Nuevo,B,C,D");
  assert.equal(g.positions, "1,2,3,4,5,1");
});

test("reserva: going to the reserve invalidates what the Consejero derived from it; coming back cleans its thread refs", () => {
  const db = reserveDb();
  const [a, b, c] = ["A", "B", "C"].map((t) => id(db, t));
  const digest = (ch, threads, edited = false) =>
    must(db, `insert into chapter_digests (chapter_id, novel_id, source_revision, summary, threads, author_edited)
              values ('${ch}', '${NOVEL}', 0, 'Resumen', '${JSON.stringify(threads)}', ${edited})`);
  const thread = (title, extra = "") =>
    must(db, `insert into story_threads (novel_id, title${extra ? ", origin, confirmed" : ""}) values ('${NOVEL}', '${title}'${extra}) returning id`);
  const onlyB = thread("Sólo de B");
  const shared = thread("De A y de B");
  const authors = thread("Del autor", ", 'author', false");
  const confirmed = thread("Confirmado", ", 'advisor', true");
  digest(a, [{ thread: shared, change: "opened", quote: "" }]);
  digest(b, [
    { thread: onlyB, change: "opened", quote: "" },
    { thread: shared, change: "advanced", quote: "" },
    { thread: authors, change: "opened", quote: "" },
    { thread: confirmed, change: "opened", quote: "" },
  ]);
  digest(c, []); // made with B's summary as "the previous chapter"
  must(db, `insert into novel_digests (novel_id, summary, based_on) values ('${NOVEL}', 'Todo', '{"${a}": 0, "${b}": 0}')`);

  move(db, "B", true, null);
  assert.equal(must(db, `select count(*) from chapter_digests where chapter_id = '${b}'`), "0", "its digest");
  assert.equal(must(db, `select count(*) from chapter_digests where chapter_id = '${c}'`), "0", "the next one's");
  assert.equal(must(db, `select count(*) from chapter_digests where chapter_id = '${a}'`), "1", "others stay");
  assert.equal(must(db, `select count(*) from novel_digests`), "0", "the global summary that included it");
  assert.equal(
    must(db, "select string_agg(title, ',' order by title) from story_threads"),
    "Confirmado,De A y de B,Del autor",
    "only the possible thread that came from it alone",
  );

  // A digest corrected by the author is kept (the app doesn't read it while in reserve)…
  move(db, "B", false, 2);
  digest(b, [{ thread: onlyB, change: "opened", quote: "" }, { thread: shared, change: "advanced", quote: "" }], true);
  must(db, `delete from story_threads where id = '${onlyB}'`);
  move(db, "C", true, null);
  move(db, "B", true, null);
  assert.equal(must(db, `select count(*) from chapter_digests where chapter_id = '${b}'`), "1");
  // …and coming back it only keeps references to threads that exist.
  move(db, "B", false, null);
  assert.equal(must(db, `select threads::text from chapter_digests where chapter_id = '${b}'`), JSON.stringify([{ quote: "", change: "advanced", thread: shared }]).replace(/,/g, ", ").replace(/:/g, ": "));
  // A global summary made without it is merely incomplete: it stays (and the app sees it is not current).
  must(db, `insert into novel_digests (novel_id, summary, based_on) values ('${NOVEL}', 'Todo', '{"${a}": 0}')`);
  move(db, "D", true, null);
  assert.equal(must(db, `select count(*) from novel_digests`), "1");
});

test("reserva: duplicating a novel keeps each chapter's group", () => {
  const db = reserveDb();
  move(db, "C", true, null);
  must(db, `select public.duplicate_novel('${NOVEL}', 'Copia')`);
  const copy = must(db, "select id from novels where title = 'Copia'");
  const g = groups(db, copy);
  assert.equal(g.main, "A,B,D,E");
  assert.equal(g.reserve, "C");
});

test("reserva: closed to the public keys", () => {
  const db = reserveDb();
  for (const fn of ["create_chapter(uuid, text, boolean, integer)", "move_chapter(uuid, boolean, integer)"]) {
    assert.equal(must(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`), "f");
    assert.equal(must(db, `select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), "f");
    assert.equal(must(db, `select has_function_privilege('service_role', 'public.${fn}', 'execute')`), "t");
  }
});

// ---------------------------------------------------------------------------
// Bloqueo de capítulos (docs/bloqueo-capitulos.md)
// ---------------------------------------------------------------------------

const CH1 = "22222222-2222-4222-8222-222222222221";
const CH2 = "22222222-2222-4222-8222-222222222222";

test("bloqueo: actualizar-bloqueo.sql over the production base (Crítico), twice, both ways, keeps every text and leaves every chapter unlocked", () => {
  for (const mode of ["editor", "psql"]) {
    const db = newDb();
    must(db, OLD.critico, "psql");
    must(db, DATA, "psql");
    assert.equal(must(db, "select count(*) from information_schema.columns where table_name = 'chapters' and column_name = 'locked'"), "0", "the base before");
    const fp = fingerprint(db);
    const texts = must(db, "select string_agg(id || ':' || revision || ':' || content, '|' order by id) from chapters");
    must(db, LOCK_MIGRATION, mode);
    must(db, LOCK_MIGRATION, mode);
    assertComplete(db);
    assertDataKept(db, fp);
    assert.equal(must(db, "select string_agg(id || ':' || revision || ':' || content, '|' order by id) from chapters"), texts, "same texts, same revisions");
    assert.equal(must(db, "select count(*) from chapters where locked or locked_at is not null"), "0", "existing chapters stay unlocked");
    assert.equal(must(db, `select string_agg(locked::text, ',') from public.novel_outline('${NOVEL}')`), "false,false");
    // schema.sql over it is still a no-op for its data.
    must(db, SCHEMA);
    assertComplete(db);
    assertDataKept(db, fp);
  }
});

test("bloqueo: schema.sql completo over the production base adds the lock without touching texts", () => {
  const db = newDb();
  must(db, OLD.critico, "psql");
  must(db, DATA, "psql");
  const fp = fingerprint(db);
  must(db, SCHEMA);
  must(db, SCHEMA, "psql");
  assertComplete(db);
  assertDataKept(db, fp);
  assert.equal(must(db, "select count(*) from chapters where locked"), "0");
});

test("bloqueo: the database refuses any change of a locked chapter's text or title, wherever it comes from", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  const before = must(db, `select title || '|' || content || '|' || revision from chapters where id = '${CH1}'`);
  const versions = must(db, `select count(*) from chapter_versions where chapter_id = '${CH1}'`);
  must(db, `update chapters set locked = true, locked_at = now() where id = '${CH1}'`);
  assert.equal(must(db, `select title || '|' || content || '|' || revision from chapters where id = '${CH1}'`), before, "locking changes nothing else (not even the revision)");

  for (const sql of [
    `update chapters set content = 'Otro texto' where id = '${CH1}'`,
    `update chapters set content = content || ' más' where id = '${CH1}'`,
    `update chapters set content = '' where id = '${CH1}'`,
    `update chapters set title = 'Otro título' where id = '${CH1}'`,
    // Unlocking and writing at once: never.
    `update chapters set locked = false, content = 'Colado al desbloquear' where id = '${CH1}'`,
    // A bulk update (an old or stray statement) can't touch it either.
    `update chapters set content = 'Todo igual' where novel_id = '${NOVEL}'`,
  ]) {
    const r = run(db, sql);
    assert.ok(!r.ok, `refused: ${sql}`);
    assert.match(r.error, /bloqueado/);
  }
  assert.equal(must(db, `select title || '|' || content || '|' || revision from chapters where id = '${CH1}'`), before, "intact");
  assert.equal(must(db, `select content from chapters where id = '${CH2}'`), "Texto del dos.", "the bulk update changed nothing at all (one statement)");
  assert.equal(must(db, `select count(*) from chapter_versions where chapter_id = '${CH1}'`), versions, "no version from a refused change");

  // The error code the server turns into 423.
  assert.equal(run(db, `do $$ begin update public.chapters set content = 'x' where id = '${CH1}'; exception when sqlstate 'P0423' then null; end $$;`).ok, true, "SQLSTATE P0423");

  // What doesn't change the text is allowed: its place in the novel, an identical write.
  must(db, `update chapters set position = 5 where id = '${CH1}'`);
  must(db, `update chapters set content = content, title = title where id = '${CH1}'`);
  // Other chapters are still editable.
  must(db, `update chapters set content = 'Texto del dos, editado.' where id = '${CH2}'`);

  // Unlocking is its own statement; then it is editable again.
  must(db, `update chapters set locked = false, locked_at = null where id = '${CH1}'`);
  must(db, `update chapters set content = 'Ya editable.' where id = '${CH1}'`);
  assert.equal(must(db, `select content from chapters where id = '${CH1}'`), "Ya editable.");
});

test("bloqueo: a locked chapter can't go to the trash, but the novel can still be duplicated and deleted", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  must(db, `update chapters set locked = true where id = '${CH1}'`);
  const r = run(db, `select public.trash_chapter('${CH1}')`);
  assert.ok(!r.ok);
  assert.match(r.error, /bloqueado/);
  assert.equal(must(db, `select count(*) from chapters where id = '${CH1}'`), "1");
  assert.equal(must(db, "select count(*) from chapter_versions where reason = 'delete'"), "0", "nothing kept for a refused delete");
  must(db, `select public.trash_chapter('${CH2}')`); // an unlocked one still goes

  // Duplicating rewrites image markers in the copy: the lock is not copied, so nothing blocks it.
  must(db, `update chapters set locked = false where id = '${CH1}'`);
  const img = must(db, "select id from manuscript_images limit 1");
  must(db, `update chapters set content = 'Antes [[imagen:${img}]] después' where id = '${CH1}'`);
  must(db, `update chapters set locked = true where id = '${CH1}'`);
  const copy = JSON.parse(must(db, `select public.duplicate_novel('${NOVEL}', 'Copia')`)).id;
  assert.ok(copy);
  assert.equal(must(db, `select count(*) from chapters where novel_id = '${copy}' and locked`), "0", "the copy starts unlocked");
  assert.doesNotMatch(must(db, `select content from chapters where novel_id = '${copy}'`), new RegExp(img), "its own image");
  assert.equal(must(db, `select content from chapters where id = '${CH1}'`), `Antes [[imagen:${img}]] después`, "the original, intact");

  // Deleting the whole novel (an explicit, confirmed action) is not blocked by its locks.
  must(db, `delete from novels where id = '${NOVEL}'`);
  assert.equal(must(db, `select count(*) from chapters where novel_id = '${NOVEL}'`), "0");
});

test("bloqueo: concurrent sessions: a save that lost the race against the lock is refused", () => {
  const db = newDb();
  must(db, SCHEMA);
  must(db, DATA, "psql");
  // The server's own save: only if unlocked and at the revision the tab saw.
  const rev = must(db, `select revision from chapters where id = '${CH1}'`);
  must(db, `update chapters set locked = true where id = '${CH1}'`);
  const out = must(db, `update chapters set content = 'Guardado tardío' where id = '${CH1}' and locked = false and revision = ${rev} returning id`);
  assert.equal(out, "", "no row");
  assert.notEqual(must(db, `select content from chapters where id = '${CH1}'`), "Guardado tardío");
});

// ---------------------------------------------------------------------------
// Bloqueo + reserva juntos (docs/integracion-bloqueo-reserva.md)
// ---------------------------------------------------------------------------

const UNDO = read("supabase/deshacer-bloqueo-reserva.sql");
const PR12 = read("tests/schema/fixtures/actualizar-bloqueo-pr12.sql");
const PR13 = read("tests/schema/fixtures/actualizar-reserva-pr13.sql");
/** Every chapter as it reads in the outline: title|locked|reserved, in order. */
const outline = (db, novel = NOVEL) =>
  must(db, `select string_agg(title || '|' || locked || '|' || reserved, ',' order by reserved, position) from public.novel_outline('${novel}')`);
/** Definitions of the functions the production code calls on chapters, to compare two bases. */
const PROD_FUNCS = ["novel_outline", "reorder_chapters", "save_chapter_version", "trash_chapter", "restore_chapter", "duplicate_novel", "chapter_trash"];
const defs = (db) =>
  must(db, `select string_agg(proname || ':' || pg_get_functiondef(oid), E'\\n---\\n' order by proname) from pg_proc
            where pronamespace = 'public'::regnamespace and proname = any(array['${PROD_FUNCS.join("','")}'])`);

test("integración: the joint migration over the production base, twice, both ways: both columns, no text lost, the old code's calls still work", () => {
  for (const mode of ["editor", "psql"]) {
    const db = newDb();
    must(db, OLD.critico, "psql");
    must(db, DATA, "psql");
    must(db, `insert into chapters (id, novel_id, title, position, content) values
      ('22222222-2222-4222-8222-222222222223', '${NOVEL}', 'Capítulo 3', 3, 'Tres.'),
      ('22222222-2222-4222-8222-222222222224', '${NOVEL}', 'Capítulo 4: La manta', 4, 'Cuatro.')`, "psql");
    must(db, `select public.save_chapter_version('22222222-2222-4222-8222-222222222224', 'manual', 'Antes')`);
    const texts = must(db, "select string_agg(id || ':' || position || ':' || md5(content), ',' order by id) from chapters");
    const versions = must(db, "select count(*) || md5(string_agg(content, '' order by id)) from chapter_versions");
    const missing = must(db, VERIFY);
    for (const what of ["chapters.locked", "chapters.reserved", "chapter_guard_locked", "move_chapter"]) assert.match(missing, new RegExp(what.replace(".", "\\.")));
    must(db, JOINT_MIGRATION, mode);
    must(db, JOINT_MIGRATION, mode);
    assertComplete(db);
    assert.equal(must(db, "select string_agg(id || ':' || position || ':' || md5(content), ',' order by id) from chapters"), texts, "ids, order and texts");
    assert.equal(must(db, "select count(*) || md5(string_agg(content, '' order by id)) from chapter_versions"), versions, "versions untouched");
    assert.equal(outline(db), "Uno|false|false,Dos|false|false,|false|false,La manta|false|false");
    // The code in production today (main) on the new base: the same calls it makes.
    assert.equal(must(db, `select count(*) from (select id, title, position, chars, words, updated_at from public.novel_outline('${NOVEL}')) o`), "4");
    must(db, `select public.reorder_chapters('${NOVEL}', (select array_agg(id order by position desc) from chapters where novel_id = '${NOVEL}'))`);
    must(db, `update chapters set content = 'Editado por el código anterior.', title = 'Nuevo título' where id = '22222222-2222-4222-8222-222222222221'`);
    must(db, `insert into chapters (novel_id, title, position) values ('${NOVEL}', 'Capítulo 5', 5)`); // its "new chapter"
    must(db, `select public.trash_chapter('22222222-2222-4222-8222-222222222223')`);
    must(db, `select public.restore_chapter('${NOVEL}', '22222222-2222-4222-8222-222222222223')`);
    assert.ok(JSON.parse(must(db, `select public.duplicate_novel('${NOVEL}', 'Copia')`)).id);
    assert.equal(must(db, "select count(*) from chapters where locked or reserved"), "0", "nothing locked or reserved until the new code does it");
    const fp = fingerprint(db);
    must(db, SCHEMA);
    assertComplete(db);
    assertDataKept(db, fp);
  }
});

test("integración: the joint migration also works where PR #12's or PR #13's migration was already applied", () => {
  // PR #12 first, with a chapter already locked whose title still carries the stored number.
  let db = newDb();
  must(db, OLD.critico, "psql");
  must(db, DATA, "psql");
  must(db, `insert into chapters (id, novel_id, title, position, content) values
    ('22222222-2222-4222-8222-222222222223', '${NOVEL}', 'Capítulo 3: Revisado', 3, 'Tres.'),
    ('22222222-2222-4222-8222-222222222224', '${NOVEL}', 'Capítulo 4', 4, 'Cuatro.')`, "psql");
  must(db, PR12);
  must(db, `update chapters set locked = true, locked_at = now() where id = '22222222-2222-4222-8222-222222222223'`);
  must(db, JOINT_MIGRATION);
  must(db, JOINT_MIGRATION, "psql");
  assertComplete(db);
  assert.equal(outline(db), "Uno|false|false,Dos|false|false,Capítulo 3: Revisado|true|false,|false|false", "the lock protects its title");
  assert.ok(!run(db, `update chapters set title = 'x' where id = '22222222-2222-4222-8222-222222222223'`).ok, "still locked");

  // PR #13 first, with a chapter already in the reserve.
  db = newDb();
  must(db, OLD.critico, "psql");
  must(db, DATA, "psql");
  must(db, PR13);
  must(db, `select public.move_chapter('22222222-2222-4222-8222-222222222222', true, null)`);
  must(db, `update chapters set title = 'Capítulo 9' where id = '22222222-2222-4222-8222-222222222221'`); // the author's own, after
  must(db, JOINT_MIGRATION);
  assertComplete(db);
  assert.equal(outline(db), "Capítulo 9|false|false,Dos|false|true", "the reserve kept; titles not stripped a second time");
});

test("integración: a locked chapter moves freely (place, reserve, back) but its text and title stay protected", () => {
  const db = reserveDb();
  const b = id(db, "B");
  must(db, `update chapters set locked = true, locked_at = now() where id = '${b}'`);
  const before = must(db, `select title || '|' || md5(content) || '|' || revision from chapters where id = '${b}'`);
  const versions = must(db, "select count(*) from chapter_versions");
  move(db, "B", false, 1);
  assert.equal(groups(db).main, "B,A,C,D,E");
  move(db, "B", true, null);
  assert.equal(outline(db), "A|false|false,C|false|false,D|false|false,E|false|false,B|true|true");
  for (const sql of [`update chapters set content = 'x' where id = '${b}'`, `update chapters set title = 'x' where id = '${b}'`]) {
    const r = run(db, sql);
    assert.ok(!r.ok && /bloqueado/.test(r.error), `in the reserve too: ${sql}`);
  }
  assert.ok(/bloqueado/.test(run(db, `select public.trash_chapter('${b}')`).error), "a locked chapter in the reserve can't go to the trash");
  move(db, "B", false, 3);
  assert.equal(groups(db).main, "A,C,B,D,E");
  assert.equal(must(db, `select title || '|' || md5(content) || '|' || revision from chapters where id = '${b}'`), before, "moving kept text, title and revision");
  assert.equal(must(db, "select count(*) from chapter_versions"), versions, "and made no version");
  assert.equal(must(db, `select locked from chapters where id = '${b}'`), "t", "still locked");
  // The manuscript's last chapter, even if locked, can't go to the reserve (the usual rule).
  for (const t of ["A", "C", "D", "E"]) move(db, t, true, null);
  assert.match(run(db, `select public.move_chapter('${b}', true, null)`).error, /al menos un capítulo/);
});

test("integración: unlock, trash and restore a chapter in the reserve: back to the reserve, unlocked; the copy keeps groups and starts unlocked", () => {
  const db = reserveDb();
  move(db, "C", true, null);
  must(db, `update chapters set locked = true where title in ('C', 'D')`);
  const copy = JSON.parse(must(db, `select public.duplicate_novel('${NOVEL}', 'Copia')`)).id;
  assert.equal(outline(db, copy), "A|false|false,B|false|false,D|false|false,E|false|false,C|false|true");
  const c = must(db, `select id from chapters where title = 'C' and novel_id = '${NOVEL}'`);
  must(db, `update chapters set locked = false where id = '${c}'`);
  must(db, `select public.trash_chapter('${c}')`);
  const back = must(db, `select public.restore_chapter('${NOVEL}', '${c}')`);
  assert.equal(must(db, `select reserved || ':' || locked from chapters where id = '${back}'`), "true:false");
  assert.equal(must(db, `select content from chapters where id = '${back}'`), "Texto de C.");
});

test("integración: deshacer-bloqueo-reserva.sql returns the base to production's functions without losing a chapter, and the joint migration applies again", () => {
  const prod = newDb();
  must(prod, OLD.critico, "psql");
  const prodDefs = defs(prod);

  const db = newDb();
  must(db, OLD.critico, "psql");
  must(db, DATA, "psql");
  must(db, `insert into chapters (novel_id, title, position, content) values ('${NOVEL}', 'Tres', 3, 'Texto del tres.')`);
  must(db, JOINT_MIGRATION);
  must(db, `select public.move_chapter('22222222-2222-4222-8222-222222222221', true, null)`);
  must(db, `update chapters set locked = true where id = '22222222-2222-4222-8222-222222222222'`);
  const texts = must(db, "select string_agg(id || ':' || md5(content) || ':' || title, ',' order by id) from chapters");
  for (const mode of ["editor", "psql"]) must(db, UNDO, mode); // twice: idempotent
  assert.equal(defs(db), prodDefs, "the same functions as production");
  assert.equal(must(db, "select count(*) from information_schema.columns where table_name in ('chapters', 'chapter_versions') and column_name in ('locked', 'locked_at', 'reserved')"), "0");
  assert.equal(must(db, "select count(*) from pg_proc where proname in ('move_chapter', 'create_chapter', 'chapter_guard_locked')"), "0");
  assert.equal(must(db, "select string_agg(id || ':' || md5(content) || ':' || title, ',' order by id) from chapters"), texts, "every chapter, text and title");
  assert.equal(must(db, `select string_agg(title, ',' order by position) from chapters where novel_id = '${NOVEL}'`), "Dos,Tres,Uno", "the reserve after the manuscript");
  assert.equal(must(db, `select string_agg(position::text, ',' order by position) from chapters where novel_id = '${NOVEL}'`), "1,2,3");
  must(db, `update chapters set content = 'Editable otra vez.' where id = '22222222-2222-4222-8222-222222222222'`);
  assert.equal(must(db, "select has_function_privilege('service_role', 'public.novel_outline(uuid)', 'execute')"), "t");
  assert.equal(must(db, "select has_function_privilege('anon', 'public.novel_outline(uuid)', 'execute')"), "f");
  // And forward again.
  must(db, JOINT_MIGRATION);
  assertComplete(db);
});

test("integración: on a base older than the Crítico the joint migration refuses to run and changes nothing", () => {
  const db = newDb();
  must(db, OLD.fase4, "psql");
  must(db, DATA, "psql");
  const fp = fingerprint(db);
  const r = run(db, JOINT_MIGRATION);
  assert.ok(!r.ok);
  assert.match(r.error, /no está al día con el Crítico/);
  assertDataKept(db, fp);
  assert.equal(must(db, "select count(*) from information_schema.columns where table_name = 'chapters' and column_name in ('locked', 'reserved')"), "0");
});

test("integración: huella.sql is the same before and after the migration (and after undoing it); only titles with a stored number change their own line", () => {
  const HUELLA = read("supabase/huella.sql");
  const db = newDb();
  must(db, OLD.critico, "psql");
  must(db, DATA, "psql");
  const before = must(db, HUELLA);
  assert.match(before, /^chapters\|2 filas · [0-9a-f]{32}$/m);
  must(db, JOINT_MIGRATION);
  assert.equal(must(db, HUELLA), before, "no title had a number: everything equal");
  must(db, UNDO);
  assert.equal(must(db, HUELLA), before, "undone: equal");

  must(db, `update chapters set title = 'Capítulo 2' where title = 'Dos'`);
  const numbered = must(db, HUELLA);
  must(db, JOINT_MIGRATION);
  const after = must(db, HUELLA);
  const diff = numbered.split("\n").filter((l, i) => l !== after.split("\n")[i]);
  assert.deepEqual(diff.map((l) => l.split("|")[0]), ["chapters.title"], "only the titles line");
});
