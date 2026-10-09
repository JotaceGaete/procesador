# Capítulos en reserva y reorganización del manuscrito

Pedido por Juan el 2026-10-09. El autor escribe capítulos en cualquier orden; los que aún no
forman parte del libro esperan en **reserva** sin contaminar el conocimiento narrativo del
Consejero ni del Asistente.

## 1. Diagnóstico (main 5359c10)

**Esquema.** `chapters(id, novel_id, title, position, content, revision, …)`. Un solo grupo:
`position` es un entero que ordena todos los capítulos de la novela. RLS activado sin
políticas; sólo la `service_role` del servidor lee y escribe. El aislamiento entre novelas
lo dan las claves foráneas compuestas `(id, novel_id)`.

**Numeración.** Se calcula al mostrar (`chapterLabel(índice, título)`), pero el alta de un
capítulo guarda el título `"Capítulo N"` (`api/novels/[id]/chapters`, `api/novels`). Al
reordenar, ese título queda con un número que ya no es el suyo.

**Orden.** `reorder_chapters(novela, ids[])` exige la lista completa y reescribe `position`
en una transacción. No hay inserción en una posición: el capítulo nuevo va al final.

**Rutas que leen capítulos para la IA** (todas leen *todos* los capítulos de la novela):

| Ruta | Lee | Para |
|---|---|---|
| `api/assist` (Asistente: escena y acciones sobre selección) | `getOutline`, `getChapterTexts`, `chapterRows`, `digestRows`, `threadRows`, `novelDigestRow`, `getMemory`, cronología | contexto, memoria temporal, «toda la historia hasta aquí», pasajes |
| `api/advisor` → `buildAdvice` (Consejero, Conversar y Analizar) | lo mismo + herramientas de lectura profunda sobre esa lista | marco (mapa, resumen global, cabos), foco, capítulos nombrados, pasajes |
| `api/advisor` con `brief` (encargo para el Asistente) | la conversación | encargo de escena |
| `conversationContext` | los mensajes y tarjetas de una conversación | historial del Consejero |
| `digestChapter`, `digestNovel`, `recomputeThreads` | `chapterRows`, fichas, cabos | **memoria derivada** (fichas, cabos, resumen global) |
| `critic/evaluate` (Crítico) | `chapterRows`, fichas, resumen global, cabos, `getMemory` | contradicciones con el resto |
| `novelChronology` | `getOutline`/`getChapterTexts`, `time_marks` | tiempo y edades en el contexto, advertencias |
| `api/novels/[id]/advisor` (panorama sin IA) | `getChapterTexts` | apariciones y repeticiones |
| `recheckObservation`, `revisionsOf` | `chapterRows` | verificar citas |

**Fugas posibles si sólo se ocultara en la interfaz:** el mapa de la novela y los pasajes por
personaje del Consejero; «leer toda la historia» del Asistente; la ficha automática al salir
de un capítulo (y con ella los cabos y el resumen global); hechos de la Memoria ligados a un
capítulo (`selectMemory` trata un capítulo desconocido como «no posterior» y los envía);
marcas de tiempo y anclas de edad; conversaciones del Consejero que leyeron el capítulo; la
papelera, que al recuperar un capítulo lo devolvería al manuscrito.

**Exportación.** El navegador construye EPUB/DOCX desde `api/novels/[id]/backup`
(`bookModel`), que trae todos los capítulos.

## 2. Diseño

### Datos

- `chapters.reserved boolean not null default false`. `position` ordena **dentro de su
  grupo**; el número visible es el índice en el manuscrito, nunca parte del título.
- Migración idempotente `supabase/actualizar-reserva.sql`: añade la columna (los capítulos
  existentes quedan en el manuscrito, con sus ids), renumera posiciones 1…n por grupo sin
  cambiar el orden, y quita del título el número automático (`Capítulo 3` → vacío;
  `Capítulo 3: La manta` → `La manta`). Los títulos anteriores quedan en las versiones.
- `chapter_versions.reserved`: la papelera recuerda el grupo; recuperar un capítulo de
  reserva lo devuelve a reserva, nunca al manuscrito.

### Operaciones (SQL, en una transacción, con la fila de la novela bloqueada)

- `create_chapter(novela, título, reservado, posición)`: crea en cualquier punto de
  cualquiera de los dos grupos.
- `move_chapter(capítulo, reservado, posición)`: reordenar (flechas, arrastrar), insertar
  entre otros y trasladar entre manuscrito y reserva son la misma operación. Renumera los dos
  grupos 1…n. El bloqueo de la novela serializa operaciones simultáneas (dos pestañas): no
  hay duplicados ni huecos, y el contenido, las imágenes, las notas y las versiones no se
  tocan (sólo cambian `reserved` y `position`). El manuscrito conserva siempre un capítulo.
- Al cambiar de grupo se invalida lo derivado: la ficha del capítulo (salvo la corregida a
  mano, que queda oculta mientras esté en reserva), los cabos posibles que sólo venían de
  ella y el resumen global que la incluía. Al volver al manuscrito, la ficha se rehace como
  la de cualquier capítulo nuevo y el resumen global queda «desactualizado».

### Aislamiento en el servidor (no en la interfaz)

Una sola regla, aplicada en la capa de acceso a datos: **lo que la IA puede leer es el
manuscrito principal, más el capítulo en reserva que el autor tiene abierto, si es el caso.**

- `chapterRows`, `getChapterTexts`, `readingOutline` reciben el capítulo abierto y devuelven
  el manuscrito en orden, más ese capítulo en reserva al final. Sin capítulo abierto, sólo el
  manuscrito. Ningún otro capítulo en reserva.
- `digestRows`, `threadRows`, `novelDigestRow` filtran por ese mismo alcance: fichas de
  capítulos fuera de él, cabos que sólo aparecen fuera y un resumen global que incluya un
  capítulo en reserva no salen.
- `scopeMemory` quita de la Memoria enviada los hechos ligados a capítulos fuera del alcance
  y las anclas de edad en ellos. La Memoria que ve el autor no cambia.
- La cronología sólo calcula sobre el manuscrito (más el abierto).
- Fichas, cabos y resumen global **nunca** se generan desde un capítulo en reserva
  (`digestChapter` lo rechaza; la relectura automática al salir no ocurre). Analizar un
  capítulo en reserva no escribe nada en la memoria general.
- Conversaciones del Consejero: cada mensaje guarda en qué capítulo se hizo y qué capítulos
  leyó. Una conversación sólo puede continuar (o preparar un encargo) si todos esos capítulos
  están en el alcance actual. Así, una conversación sobre un capítulo en reserva no viaja al
  manuscrito, y una del manuscrito que leyó un capítulo luego devuelto a reserva queda
  retenida hasta que vuelva (o hasta abrir ese capítulo). Se calcula al leer: no hay que
  borrar nada y el efecto es inmediato.
- Crítico: puede evaluar un capítulo en reserva (es un análisis pedido), con el manuscrito
  como antecedente y sin otros capítulos en reserva.
- Con un capítulo en reserva abierto, el contexto lo dice: no forma parte todavía del
  manuscrito y su lugar en la historia no está decidido.

### Exportación y copia

- La exportación del libro (EPUB, DOCX) sólo incluye el manuscrito.
- La copia de seguridad incluye todo, con el grupo de cada capítulo.
- Duplicar la novela conserva el grupo.

### Interfaz

- Lista lateral: **Manuscrito** (numerado) y **Capítulos en reserva** (sin número).
- Por capítulo: ↑ ↓ (se conservan), Renombrar, Eliminar y un menú «Mover» con *A reserva*
  / *Al manuscrito: al principio, después del capítulo N…*. «+ Insertar después» en el
  manuscrito; «+ Nuevo capítulo» y «+ Nuevo en reserva».
- Escritorio: arrastrar y soltar dentro de un grupo y entre grupos. En iPhone se usan las
  flechas y el menú (el arrastre táctil no se activa: evita mover capítulos al hacer scroll).
- El editor muestra «En reserva» en la cabecera del capítulo.

### Compatibilidad con el bloqueo de capítulos (PR #12, en borrador)

Ambos cambian `novel_outline` (bloqueo añade `locked`; reserva añade `reserved`) y la lista
lateral. Quien se integre segundo combina las dos columnas; mover un capítulo bloqueado está
permitido (el bloqueo protege texto y título, no la posición).

## 3. Orden de despliegue

1. Ejecutar `supabase/actualizar-reserva.sql` en el SQL Editor (idempotente). El código actual
   sigue funcionando con la base nueva: no hay capítulos en reserva hasta que el código nuevo
   los cree.
2. Desplegar el código.

## 4. Pruebas

- `tests/unit/reserva.test.ts`: alcance de lectura, memoria filtrada (hechos y anclas de edad),
  numeración, exportación sin la reserva, copia de seguridad.
- `tests/schema/run.mjs`: la migración sobre una base al nivel del Crítico (ids y datos
  intactos, títulos «Capítulo N» limpiados), las funciones idénticas a `schema.sql`, crear,
  mover, reordenar, papelera, concurrencia, invalidación, duplicar y privilegios.
- `tests/e2e/reserva.test.mjs`: cada ruta de IA (escena con manuscrito, edición, todas las
  acciones del Consejero, lectura profunda, conversación, fichas, resumen global, Crítico,
  comparación) con palabras únicas en la reserva y en lo derivado de ella, buscadas en lo que
  recibe la IA; análisis explícito de un capítulo en reserva (lo lee, no lee otro, no escribe
  memoria); conversación fuera de alcance (409); incorporar y devolver a la reserva con
  invalidación; concurrencia; interfaz en escritorio (flechas, arrastrar, «Mover», recarga) y
  en iPhone emulado.
- Safari real (escritorio e iPhone) no está disponible en el entorno de pruebas: el teléfono
  se emula con Chromium (pantalla de 390 px, táctil). Conviene probarlo a mano en el iPhone.
