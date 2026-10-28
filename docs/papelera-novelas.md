# Papelera de novelas

Eliminar una novela completa ya no la borra: la manda a la **papelera** durante **30 días**. Pasado ese plazo, el servidor la borra de verdad, con sus capítulos, versiones, memoria y archivos.

## Reglas

- **Eliminar** (`DELETE /api/novels/[id]`) marca `novels.deleted_at` (`trash_novel`). Nada se borra.
- **Mientras está en la papelera** la novela no aparece en la biblioteca (`library()`) y no se abre: `getNovel` responde 404. Así no la usan el Asistente, el Consejero ni la duplicación.
- **Recuperar** (`POST /api/novels/[id]/restore`, `restore_novel`) la devuelve a la biblioteca tal como estaba.
- **Papelera** (`GET /api/novels/trash`, `novel_trash()`) lista las novelas eliminadas, con capítulos, palabras y el día en que se borran. Al abrirla, purga las que cumplieron 30 días.
- **Purga** (`src/lib/novel-trash-server.ts`): borra la fila (cascada) y después los archivos de Storage. Es la misma rutina de borrado de archivos que ya usaba la eliminación.
- El plazo se calcula en `src/lib/novel-trash.ts` (`NOVEL_TRASH_DAYS`, `trashCutoff`, `purgeDate`).

## No incluido (decisión del autor)

- No hay botón de «eliminar definitivamente» dentro de la papelera: sólo la purga automática a los 30 días.

## Archivos

- `supabase/schema.sql` (bloque «Papelera de novelas») y `supabase/actualizar-papelera-novelas.sql` para la base existente.
- `library()` y `novel_trash()` se crean después de la comprobación de esquema completo: una ejecución parcial se detiene con su mensaje claro (ver `tests/schema/run.mjs`).
- Pruebas: `tests/unit/novel-trash.test.ts`, `tests/e2e/papelera-novelas.test.mjs` y el caso de la biblioteca en `tests/e2e/ui.test.mjs`.
