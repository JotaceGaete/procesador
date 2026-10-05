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
const VERIFY = read("supabase/verificar.sql");
const OLD = {
  "2b": read("tests/schema/fixtures/schema-2b.sql"),
  fase1: read("tests/schema/fixtures/schema-fase1.sql"),
  fase4: read("tests/schema/fixtures/schema-fase4.sql"),
};
const TABLES = [
  "novels", "chapters", "characters", "relationships", "places", "facts", "fact_characters", "assets",
  "character_images", "manuscript_images", "ai_usage", "story_threads", "chapter_digests", "novel_digests",
  "advisor_conversations", "advisor_messages", "advisor_observations", "chapter_versions",
];
/** What only schema.sql brings (versions and trash), not actualizar-consejero.sql. */
const AFTER_CONSEJERO = /chapter_versions|save_chapter_version|trash_chapter|chapter_trash|restore_chapter|chapter_version_auto|chapters_version/;

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
