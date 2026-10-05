# Versiones, papelera y copia de seguridad

> Estado: **implementado (Fase 0 del plan profesional).** Requiere actualizar Supabase: ejecutar `supabase/schema.sql` completo.

## Problema

Antes de esta fase, la única protección era el autoguardado y el Deshacer del navegador:

- cada guardado sobrescribía el texto del capítulo, sin historial;
- el Deshacer vive en la memoria de la pestaña y se pierde al recargar o al cambiar de capítulo, también después de aplicar una propuesta de la IA;
- *Conservar la mía*, ante un conflicto, pisaba la versión de la otra pestaña o dispositivo sin dejar copia;
- eliminar un capítulo era definitivo.

## Principios

1. **Nada que el autor escribió se pierde por una acción de la app.** Antes de reemplazar texto (IA, restaurar, *Conservar la mía*, eliminar) se guarda lo que había.
2. **La red de seguridad no depende del navegador.** La copia automática la hace la base de datos (un trigger), aunque la pestaña se cierre o falle.
3. **Sin ruido.** No se repite una versión idéntica a la anterior, y las copias automáticas se espacian y se podan.
4. **Lo del autor no se borra solo.** Las versiones que el autor guarda con nombre nunca se podan.

## Modelo

Una tabla, `chapter_versions`: una copia completa del texto de un capítulo (con su título y posición en ese momento), su motivo, un nombre opcional y la fecha.

| Motivo | Cuándo | Quién la crea |
|---|---|---|
| `auto` | Al guardar un cambio, si el capítulo no tiene ninguna versión de los últimos 30 minutos. Guarda el texto **anterior** al cambio. | Trigger `chapters_version` (`chapter_version_auto`) |
| `ai` | Justo antes de *Insertar en el cursor* o *Reemplazar selección*. | La app (`Workspace`) |
| `conflict` | Antes de *Conservar la mía*: el texto de la otra pestaña o dispositivo. Si no se puede guardar, no se sobrescribe nada. | La app (`useAutosave`) |
| `manual` | *Guardar versión actual*, con nombre opcional («Primer borrador»). | El autor |
| `restore` | Antes de restaurar otra versión: el texto que se reemplaza. Si no se puede guardar, no se restaura. | La app |
| `delete` | Al eliminar el capítulo. | `trash_chapter` |

Reglas (`save_chapter_version`):

- Un texto vacío no se guarda.
- Si el texto es idéntico al de la última versión, no se repite (salvo `manual` y `delete`).
- Se conservan las **100** versiones automáticas más recientes de cada capítulo (`auto`, `ai`, `conflict`, `restore`). Las `manual` y `delete` no se podan.
- Duplicar una novela no copia versiones, y reescribir los marcadores de imagen de la copia no deja ninguna.
- Al eliminar una novela se eliminan sus versiones (la eliminación de una novela entera sigue siendo definitiva, con confirmación explícita; la copia de seguridad es su protección).

## Papelera

- **Eliminar** un capítulo (`trash_chapter`) guarda su texto como versión `delete` y borra el capítulo, en una transacción. Sus versiones quedan en la papelera: `chapter_id` pasa a `null` y `source_chapter_id` recuerda de qué capítulo eran.
- **Recuperar** (`restore_chapter`) lo devuelve **al final** de la novela con el título y el texto de su última versión, y con todo su historial. Las imágenes del manuscrito que seguían en la novela (quedaron *sin colocar* al eliminarlo) vuelven a ese capítulo.
- Lo eliminado hace más de **30 días** se vacía al abrir la papelera (`chapter_trash`).
- Una novela conserva siempre al menos un capítulo.
- La ficha de lectura del Consejero del capítulo eliminado no vuelve: se puede rehacer.

## Interfaz

En la lista de capítulos:

- **Versiones de este capítulo**: guardar la versión actual con nombre; la lista de versiones (fecha, motivo o nombre, palabras); al abrir una, la comparación con el texto actual (en verde lo que tiene la versión y hoy no está, tachado lo del texto actual que la versión no tiene), *Restaurar esta versión* y *Copiar su texto*.
  - Restaurar guarda antes el texto actual como versión y reemplaza el texto en el editor como un solo paso que se puede **deshacer** (aviso con *Deshacer*, o `Ctrl/⌘+Z`).
- **Papelera**: los capítulos eliminados, con *Recuperar*.
- Eliminar un capítulo avisa de que irá a la papelera durante 30 días.

La comparación (`src/lib/diff.ts`) es por párrafos y, dentro de los que cambiaron, por palabras (Myers). Un bloque demasiado distinto para compararlo palabra a palabra se muestra entero como quitado y añadido. Los tramos largos sin cambios se acortan.

## Copia de seguridad

En la ventana de la novela, **Descargar copia de seguridad** baja un `.zip`:

| Archivo | Contenido |
|---|---|
| `LEEME.txt` | Qué es cada archivo. |
| `novela.md` | La novela completa para leer: cursivas `*así*`, cambios de escena `* * *`, imágenes con su ruta en la copia y su pie. |
| `capitulos/NN Título.txt` | Cada capítulo exactamente como lo guarda Procesador (con sus marcadores), para recuperar su texto. |
| `procesador.json` | Todo: novela, Guía Maestra, capítulos, Memoria, lectura del Consejero (cabos, fichas, resumen) e imágenes (usos y archivos). |
| `imagenes/…` | Los archivos originales, tal como se subieron. |

- El servidor devuelve los datos (`/api/novels/[id]/backup`); el navegador descarga cada original por su enlace firmado de corta duración (pueden superar lo que una función puede devolver) y arma el ZIP (`src/lib/zip.ts`, sin compresión: lo abre cualquier sistema).
- Si una imagen no se puede descargar, la copia se hace igual y lleva `IMAGENES-QUE-FALTAN.txt`; la app lo avisa.
- El nombre del archivo va sin acentos (algunos navegadores descartan un nombre con otros caracteres y lo guardan como «download»); los nombres dentro del ZIP los conservan.
- No incluye las versiones de los capítulos, ni el uso de la IA, ni las conversaciones del Consejero.

## Actualizar Supabase

Ejecutar `supabase/schema.sql` completo en el SQL Editor (idempotente, conserva los datos). Añade la tabla `chapter_versions`, el trigger `chapters_version`, las funciones `save_chapter_version`, `trash_chapter`, `chapter_trash` y `restore_chapter`, y actualiza `word_count` (los separadores no cuentan) y `duplicate_novel`. `supabase/verificar.sql` lista lo que falte.

## Fuera de esta fase

- Papelera de novelas enteras.
- Restaurar sólo una parte de una versión (hoy: copiar su texto y pegar).
- Incluir las versiones en la copia de seguridad, y restaurar una novela desde una copia.
- Copias de seguridad automáticas o programadas.
