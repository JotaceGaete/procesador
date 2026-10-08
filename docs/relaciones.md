# Relaciones personalizadas

> Sin cambios en Supabase ni en el modelo de datos: el tipo de relación es texto libre en
> `relationships.kind`, como siempre.

## Qué ve el autor

En **Memoria → Relaciones**, el tipo de relación se elige en un selector con:

- **Comunes:** hermano de, padre de, pareja de, amante de, amigo de, enemigo de, desconfía de,
  le debe a, trabaja para, le teme a… (`COMMON_RELATIONS` en `src/lib/relations.ts`).
- **Usadas en esta novela:** las que el autor ya creó en esta novela, una vez cada una, para
  reutilizarlas sin volver a escribirlas.
- **+ Crear relación personalizada:** abre un campo para escribir cualquier otra («vecino de»,
  «ex amante de», «protegido de», «socio de», «informante de», «padrino de»…).

Una relación se puede abrir y cambiar después: su tipo aparece seleccionado tal como está
guardado (también si es una variante antigua), y se puede elegir otro o crear uno nuevo.

## Sin duplicados triviales

Dos formas que sólo difieren en **mayúsculas, espacios o tildes** son el mismo tipo:
`desconfia de`, `Desconfía de` y `desconfía  de` son «desconfía de».

- Esa comparación sólo sirve para comparar: nunca se muestra ni se guarda.
- Si el tipo ya existe en la novela, se usa **la forma que ya tiene la novela**; si no, la forma
  común; si no, **lo que escribió el autor**, sin cambiar mayúsculas ni tildes (sólo se quitan los
  espacios de los extremos y los repetidos). El formulario lo dice: «Ya existe como «Ex amante
  de»: se usará esa forma.»
- La «ñ» es una letra, no una tilde: «año» y «ano» son distintos.
- La API aplica la misma regla al crear y al editar (`relationKind` en `src/lib/memory-server.ts`),
  así que ningún camino guarda un duplicado trivial.
- Los datos que ya existen no se reescriben.

## Dónde llega

Una relación personalizada es una relación como cualquier otra (`relationships.kind`):

- la ficha de los dos personajes y la lista de Relaciones;
- el contexto del Asistente («Naty → ex amante de → Emily») y el del Consejero;
- la copia de seguridad (`procesador.json`) y la novela duplicada (`duplicate_novel`).

Restaurar una novela desde una copia de seguridad no existe todavía en Procesador
(docs/deuda.md); cuando exista, el tipo irá en `kind` como el resto.

## Pruebas

`tests/unit/relations.test.ts` (comparación, forma guardada, usadas en la novela),
`tests/unit/prompts.test.ts` y `tests/unit/deep.test.ts` (Asistente y Consejero) y
`tests/e2e/relations.test.mjs` (crear, reutilizar, duplicados, fichas, edición, API, contexto de
IA, copia, duplicar e iPhone).
