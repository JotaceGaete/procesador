// Papelera de novelas (docs/papelera-novelas.md): eliminar una novela la manda a la papelera,
// donde se puede recuperar; mientras está allí no se abre ni aparece en la biblioteca.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { login, resetDb, client } from "./helpers.mjs";

let call;

before(async () => {
  await resetDb();
  call = client(await login());
});

test("API: eliminar manda la novela a la papelera y se recupera con todo lo suyo", async () => {
  const id = (await call("/api/novels", "POST", { title: "Papelera de prueba" })).data.id;
  await call(`/api/novels/${id}/chapters`, "POST", { title: "Capítulo dos" });

  const removed = await call(`/api/novels/${id}`, "DELETE");
  assert.equal(removed.status, 204);

  const library = (await call("/api/novels")).data;
  assert.ok(!library.some((n) => n.id === id), "la biblioteca no la muestra");
  const trash = (await call("/api/novels/trash")).data;
  const entry = trash.find((n) => n.id === id);
  assert.ok(entry, "la papelera la lista");
  assert.equal(entry.title, "Papelera de prueba");
  assert.equal(entry.chapters, 2);
  assert.equal((await call(`/api/novels/${id}`)).status, 404, "no se abre desde la papelera");

  const restored = await call(`/api/novels/${id}/restore`, "POST");
  assert.equal(restored.status, 204);
  assert.ok((await call("/api/novels")).data.some((n) => n.id === id), "vuelve a la biblioteca");
  assert.ok(!(await call("/api/novels/trash")).data.some((n) => n.id === id), "sale de la papelera");
  const back = await call(`/api/novels/${id}`);
  assert.equal(back.status, 200);
  assert.equal(back.data.chapters.length, 2, "con sus capítulos");
});

test("API: restaurar o eliminar dos veces no hace nada extraño", async () => {
  const id = (await call("/api/novels", "POST", { title: "Dos veces" })).data.id;
  assert.equal((await call(`/api/novels/${id}/restore`, "POST")).status, 404, "no está en la papelera");
  await call(`/api/novels/${id}`, "DELETE");
  assert.equal((await call(`/api/novels/${id}`, "DELETE")).status, 404, "ya está en la papelera");
  await call(`/api/novels/${id}/restore`, "POST");
});
