# Consejero literario

> Estado: **diseño aprobado como base. Sin implementar.** Decisiones del autor en "Decisiones tomadas", al final; prevalecen sobre el resto del documento.

## Qué es, y qué no es

|  | Asistente | Consejero |
|---|---|---|
| Papel | **Escribe contigo**: reescribe una selección, desarrolla una escena | **Piensa contigo**: lee, comprende y analiza la obra |
| Salida | Una propuesta de texto que puedes aplicar al manuscrito | Observaciones y preguntas. **Nunca** texto aplicable al manuscrito |
| Alcance | Una selección o el punto del cursor | Una selección, un capítulo, la novela hasta aquí o la novela entera |
| Memoria | La consulta | Conversaciones que se pueden continuar y observaciones que se pueden guardar |

**Principios:**

- **Consejo, no modificación.** El Consejero no tiene ninguna acción que cambie el manuscrito. Lo más que hace es *proponer*:
  - un hecho para la Memoria, que queda como `suggested` hasta que lo apruebes (el estado ya existe en la tabla `facts`);
  - un cabo pendiente, que no es definitivo hasta que lo confirmas.
- **Nunca verdad absoluta.** Cada observación tiene un tipo, una confianza y su evidencia: capítulo y cita literal. Si no la tiene, se presenta como impresión.
- **La decisión es del autor.** El tono es el de un editor de confianza: preguntas y posibilidades, no veredictos.

## 1. Qué tenemos ya y se reutiliza

| Pieza existente | Uso en el Consejero |
|---|---|
| **Capítulos** (`chapters`: orden, texto, `revision`, `updated_at`) | El texto es la fuente de verdad. `revision` indica, sin coste, si un resumen está desactualizado. |
| **Guía Maestra** (`novels.guide`) | Intención declarada del autor: tono, temas, lo que evitar. Contra ella se juzga el ritmo y el estilo. |
| **Sinopsis y notas del autor** (`novels.synopsis`, `notes`) | El plan del autor, distinto del resumen generado. El Consejero puede comparar lo planeado con lo escrito. |
| **Personajes** (fichas completas, incluidos *Sabe* / *No sabe*, *Secretos* y *Arco*) | Coherencia de reacciones, revelaciones prematuras, arcos desaprovechados. **No se duplican**: los resúmenes se refieren a los personajes por su id. |
| **Relaciones, lugares, hechos** (con capítulo, fecha y personajes) | Continuidad. Los hechos aprobados son canon del autor y mandan sobre cualquier resumen. |
| `facts.status = 'suggested'` | Destino de los hechos que el Consejero propone, sin crear otra tabla. |
| **Contexto** (`lib/ai/context.ts`) | `nameMatcher` (nombres y apodos), `excerpts` (pasajes de un personaje en toda la novela), `selectMemory`, `nearbyRange`, `estimateTokens`, `buildManuscript`. |
| **Imágenes del manuscrito** | `describeImages` ya convierte cada marcador en `[Imagen: …]`. |
| **Proveedores** (`lib/ai/providers.ts`) | Interfaz común para Claude, GPT y Grok, streaming, *Probar con*, caché del bloque grande en Claude. Se amplía (sección 7); no se duplica. |
| **Patrón de coste** | `dryRun` estima los tokens antes de enviar y pide confirmación por encima de ~30.000. Se reutiliza tal cual. |
| **Cronología** (diseñada) | Marcas temporales y edades: cuando exista, el Consejero las lee como un dato estructurado más. |

**Lo que se puede responder sin IA**, porque son datos, no juicio:

- **"¿Hace cuánto que no aparece X?"** Un índice de menciones por capítulo con `nameMatcher` da el último capítulo y cuántas palabras han pasado desde entonces. Es exacto e inmediato.
- **Presencia de cada personaje por capítulo**, para "¿qué personajes estoy desaprovechando?" (datos de partida; el juicio lo pone el modelo).
- **Repeticiones léxicas:** frases y expresiones repetidas (n-gramas), muletillas y palabras sobreusadas por capítulo. La parte mecánica la hace el código; el modelo sólo juzga si una repetición es un recurso o un problema.
- **Mapa de la novela:** capítulos, palabras y personajes presentes.

Estos datos se calculan al vuelo desde el texto, que ya se lee para el contexto. Para cientos de páginas son milisegundos y no requieren tablas nuevas.

## 2. Qué información nueva hay que generar

Sólo lo que no se puede calcular y que la Memoria no guarda:

### Ficha de capítulo (`chapter_digests`), una por capítulo

| Campo | Contenido | Por qué no está ya |
|---|---|---|
| `summary` | Resumen de 120–250 palabras | Nada resume capítulos |
| `events` | 3–8 acontecimientos: texto breve, personajes (ids) y una **cita ancla** literal de 4–15 palabras | Los hechos de Memoria son restricciones de continuidad que fija el autor, no el registro de lo que pasa |
| `presence` | Por personaje: `present` (en escena) o `mentioned` (sólo nombrado) | El índice de menciones no distingue estar de ser nombrado |
| `revelations` | Qué información se revela, a quién (lector o personaje), con cita ancla | Base de "¿revelo esto demasiado pronto?" y del *Sabe / No sabe* en cada momento |
| `threads` | Cabos que abre, hace avanzar o cierra (por id, ver abajo) | — |
| `notes` | Una línea de ritmo y estructura: escena, resumen, diálogo, tensión | — |

No se repiten rasgos de personajes, lugares ni hechos: esos están en Memoria y se citan por id.

### Cabos y conflictos (`story_threads`)

La única entidad nueva que cruza capítulos:

- un título, un tipo (conflicto, misterio, promesa al lector, relación, otro) y un estado (abierto, cerrado o abandonado a propósito);
- en qué capítulo se abrió, cuándo apareció por última vez y dónde se cerró.

Los propone el Consejero al resumir; **los confirma, renombra, fusiona o cierra el autor**. Uno sin confirmar se muestra como "posible cabo".

### Resumen global (`novel_digests`)

El argumento hasta el último capítulo resumido, en 600–1.200 palabras, y el estado de los cabos abiertos. Se **deriva de las fichas de capítulo**, no del texto completo, así que regenerarlo es barato.

### Lo que no se genera

- **Embeddings ni base vectorial.** La recuperación es léxica (nombres, apodos, palabras clave de la pregunta, cabos), sobre los fragmentos que ya sabemos leer. Si en la práctica no basta, se añadiría `pgvector` sobre párrafos, sin cambiar el resto.
- **Arcos de personaje.** Se reconstruyen al vuelo juntando los acontecimientos de las fichas en los que aparece cada personaje.
- **Copias del texto.** Nunca se guarda texto del manuscrito fuera de `chapters`, salvo las citas ancla, que son cortas y verificables.

## 3. Cómo se mantienen actualizados los resúmenes

- **Vigencia:** cada ficha guarda la `revision` del capítulo con la que se hizo. Si el capítulo tiene otra, la ficha está **desactualizada**. Comprobarlo no cuesta nada.
- **Cuándo se generan** (perezoso y visible, nunca a cada pulsación):
  1. **Al consultar.** Si una consulta necesita fichas que faltan o están viejas, el Consejero lo dice ("3 capítulos sin leer, ≈ 40.000 tokens") y las genera antes de responder. Por encima del umbral, pide confirmación.
  2. **Al terminar de trabajar un capítulo.** Al cambiar de capítulo, si el anterior cambió *de forma sustancial*, se encola su ficha.
  3. **Desde un botón** *Actualizar la lectura de la novela*, con la estimación de coste a la vista.
- **Cambio menor o sustancial:** la ficha guarda un hash por párrafo, de modo que se sabe cuántos cambiaron. Corregir erratas o cambiar unas pocas palabras no regenera nada (la ficha queda "al día con retoques"); un capítulo reescrito sí. El umbral es configurable, por ejemplo un 15 % de párrafos o una inserción o borrado de más de 300 palabras.
- **Sin servidor permanente:** Vercel no tiene procesos en segundo plano. La generación la lanza el navegador (una petición por capítulo, con `maxDuration`) y el progreso se ve en el panel. Si se cierra la pestaña, lo pendiente se retoma en la siguiente consulta.
- **Resumen global:** se marca desactualizado cuando cambia cualquier ficha y se rehace a partir de las fichas, sólo cuando una consulta lo necesita.
- **Modelo económico:** las fichas usan el modelo "rápido" de cada proveedor (sección 7), con salida estructurada y validada.

## 4. Cómo se selecciona el contexto de cada consulta

Contexto **jerárquico por niveles**, con presupuesto de tokens por nivel. Lo estable va primero para aprovechar la caché.

| Nivel | Contenido | Cuándo |
|---|---|---|
| **0 · Marco** | Instrucciones del Consejero, Guía Maestra, sinopsis del autor, **mapa de la novela** (por capítulo: título, una línea de su ficha, palabras y personajes presentes; unos 40 tokens por capítulo) y resumen global | Siempre |
| **1 · Foco** | La selección, o el capítulo en análisis **completo y vivo** (con lo no guardado del editor), nunca su ficha | Siempre que haya foco |
| **2 · Estructura** | Memoria relevante (`selectMemory` por los nombres de la pregunta y del foco), cabos abiertos y fichas completas de los 2–3 capítulos anteriores y de los capítulos donde aparecen los personajes implicados | Casi siempre |
| **3 · Pasajes** | Fragmentos de capítulos anteriores (detalle abajo) | Según la pregunta |
| **4 · Capítulos completos** | Uno o varios capítulos enteros: los nombrados en la pregunta ("compara el 3 con el 7") o, con confirmación y caché, la novela entera | Sólo si hace falta |

**Pasajes pertinentes del nivel 3,** sin enviar capítulos enteros:

- **Por personaje:** `excerpts` ya existe.
- **Por cabo:** los capítulos donde la ficha dice que avanzó, y dentro de ellos los párrafos de su cita ancla.
- **Por palabras de la pregunta:** puntuación léxica de párrafos (tipo BM25) con los términos de la pregunta, nombres y apodos.
- **Por revelación:** para "¿revelo esto demasiado pronto?", los párrafos de las citas ancla de revelaciones relacionadas.

Cada pasaje va con su capítulo. Se recortan por presupuesto, repartidos a lo largo de la novela como ya hace `excerpts`.

**Recetas por acción:** cada acción rápida declara sus niveles y presupuestos.

| Acción | Foco | Estructura y pasajes | Presupuesto orientativo de entrada |
|---|---|---|---|
| Analizar capítulo | Capítulo completo | Fichas anteriores, cabos, Memoria de quienes aparecen, pasajes de sus personajes | ~25k |
| ¿Cómo seguir? | Final del capítulo actual y el capítulo | Cabos abiertos, resumen global, sinopsis del autor, personajes desaprovechados (dato) | ~20k |
| Buscar repeticiones | Capítulo o novela | Informe léxico calculado y fichas (para repeticiones de conflicto o idea) | ~15k |
| Cabos pendientes | — | Todos los cabos, fichas resumidas | ~15k |
| Coherencia | Selección o capítulo | Hechos, fichas (*Sabe / No sabe*), pasajes por personaje y por revelación | ~30k |
| Pregunta libre | Lo que esté abierto | Planificador (abajo) | ~15–30k |

**Preguntas libres:**

- **Versión 1:** un **planificador determinista**. Reconoce personajes y lugares (`nameMatcher`), números o títulos de capítulo, cabos por título y palabras clave de intención (continuar, repetir, coherente, pronto, cabo…), y elige la receta más cercana.
- **Versión 2:** **lectura profunda** opcional. Se le dan al modelo herramientas de sólo lectura (`leer_ficha`, `buscar_pasajes`, `leer_capitulo`) y él pide lo que necesita, con un tope de llamadas y de tokens. Los tres proveedores admiten llamadas a herramientas, pero es más lento y caro, así que es una opción explícita, no el modo por defecto.

**Transparencia:** cada respuesta dice qué se leyó ("Leí: capítulo 7 completo, fichas 1–6, fichas de Erika y Juan, 4 pasajes · 18.400 tokens").

## 5. Cómo se evitan contradicciones entre resúmenes y manuscrito

1. **Jerarquía de autoridad, escrita en las instrucciones:**
   - el manuscrito (el texto vivo) > los hechos aprobados y fichas de Memoria > la Guía Maestra > los cabos confirmados > las fichas de capítulo y el resumen global (derivados, pueden estar viejos) > la inferencia del modelo;
   - si un resumen contradice un pasaje, manda el pasaje.
2. **El foco nunca va resumido:** el capítulo analizado o actual se envía como texto, incluido lo no guardado.
3. **Fichas desactualizadas:** o se rehacen antes de la consulta o se envían marcadas ("resumen de una versión anterior del capítulo 4; el texto cambió en 3 de 20 párrafos"). Nunca se presentan como actuales.
4. **Citas verificables:** toda observación que afirme algo del texto lleva capítulo y cita literal.
   - El servidor **comprueba que la cita existe** en ese capítulo (comparación normalizada: espacios, comillas, mayúsculas).
   - Las citas verificadas se pueden pulsar para ir al texto.
   - Las que no aparecen se muestran como "sin cita verificable" y bajan de confianza.
   - Lo mismo con las citas ancla de las fichas: una ficha con anclas que ya no existen queda desactualizada aunque la revisión coincida.
5. **Correcciones del autor:** una ficha o un cabo se pueden corregir a mano. Esa corrección prevalece y no se pisa al regenerar, salvo que el capítulo haya cambiado; entonces se avisa: "tu corrección puede haber quedado vieja".
6. **Sin escritura automática en Memoria:** lo que el Consejero cree canon sólo llega como hecho `suggested`.

## 6. Qué pasa cuando el autor modifica un capítulo antiguo

- Su `revision` sube, así que su ficha queda desactualizada.
- **Si el cambio fue menor** (pocos párrafos), la ficha sigue usándose, anotando "con retoques". Las citas ancla se reverifican; si alguna desapareció, la ficha pasa a desactualizada.
- **Si fue sustancial**, se encola su ficha. Al rehacerla, sus cabos (abiertos, avanzados o cerrados en ese capítulo) se reconcilian:
  - un cabo que ese capítulo cerraba y ya no cierra vuelve a *abierto*, y el panel lo indica;
  - un cabo nuevo aparece como *posible cabo*.
- **El resumen global** se marca desactualizado y se rehace a partir de las fichas, sin releer la novela.
- **Las fichas de capítulos posteriores no se tocan:** resumen su propio texto. Lo que sí puede cambiar es la *coherencia* entre capítulos. Por eso las **observaciones guardadas** registran las revisiones en que se basaron; si alguno de esos capítulos cambió, se marcan "basada en una versión anterior del capítulo 4" y ofrecen *Volver a comprobar*.

## 7. Modelos, tokens y coste

### Desacople del modelo

Hoy cada proveedor tiene un modelo fijo por variable de entorno. Se añade la noción de **rol**:

| Rol | Uso | Variable (ejemplo) |
|---|---|---|
| `write` | Asistente (como hoy) | `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `XAI_MODEL` |
| `advise` | Respuestas del Consejero | `ANTHROPIC_MODEL_ADVISE`… (por defecto, el de `write`) |
| `digest` | Fichas, resumen global, planificador | `ANTHROPIC_MODEL_FAST`… (un modelo económico) |

`CompletionRequest` gana `role`, `maxOutputTokens`, un **formato estructurado** opcional (esquema JSON) y **bloques cacheables** ordenados. Cada proveedor lo traduce a su API:

- **Claude:** salida estructurada y `cache_control` en los bloques estables;
- **GPT:** `json_schema` y caché automática de prefijo;
- **Grok:** JSON validado por nosotros.

El servidor **valida siempre** la salida estructurada con el mismo esquema. Si no es válida, reintenta una vez y, si vuelve a fallar, informa del error en vez de guardar basura. El Consejero no sabe qué modelo responde, y *Probar con* sigue funcionando.

### Control de coste

- **Presupuestos por receta** (sección 4) y por nivel, recortando primero los pasajes menos pertinentes.
- **Estimación previa** (`dryRun`) en el panel, con confirmación por encima de un umbral, como hoy.
- **Caché:** el orden instrucciones → Guía → resumen global → mapa → fichas estables va **siempre primero e igual**. En una conversación o en varias acciones seguidas ese prefijo se factura a precio de caché (explícito en Claude, automático en GPT y Grok).
- **Fichas una sola vez:** una novela de ~300 páginas (unos 100.000 palabras, ~140k tokens) se resume una vez con el modelo económico. Después sólo se rehacen los capítulos que cambian de verdad.
- **Salidas acotadas:** acciones rápidas con un máximo de 1.500–3.000 tokens de salida y menos esfuerzo de razonamiento que el análisis global.
- **Lo calculable no va al modelo** como pregunta: va como dato (menciones, repeticiones léxicas, recuentos).
- **Registro de uso** (`ai_usage`): tokens de entrada, de caché y de salida por propósito y modelo. El panel muestra el gasto estimado del mes. Los tres SDK devuelven el uso; hoy se descarta.
- **Conversación compacta:** sólo los últimos turnos van literales; los anteriores, en un resumen corto que se actualiza con el modelo económico.

## 8. Interfaz

El panel derecho pasa a tener **dos pestañas de primer nivel**, *Asistente* y *Consejero*, con identidad visual distinta: el Consejero usa otro color de acento y un subtítulo, "piensa contigo, no cambia el texto".

**Consejero:**

```
┌─ Consejero ─────────────────────────────── ⓘ ┐
│ Sobre: [Selección] [Capítulo 7] [Hasta aquí] [Toda la novela]
│
│ [Analizar capítulo] [¿Cómo seguir?] [Repeticiones]
│ [Cabos pendientes] [Coherencia] [Personajes]
│
│ ┌ Posible contradicción · confianza media ─────┐
│ │ En el cap. 3 Elena "nunca había visto el mar"; │
│ │ en el 7 recuerda "los veranos en Cartagena".   │
│ │ › cap. 3: «nunca había visto el mar»   [Ir]    │
│ │ › cap. 7: «los veranos en Cartagena»   [Ir]    │
│ │ [Guardar] [Descartar] [Proponer hecho]         │
│ └────────────────────────────────────────────────┘
│ ┌ Cabo pendiente ─ "La carta de Marta" ─────────┐
│ │ Abierto en el cap. 2, sin aparecer desde el 4.  │
│ │ [Ir] [Guardar] [Marcar cerrado] [Descartar]     │
│ └────────────────────────────────────────────────┘
│
│ Leí: cap. 7 completo, fichas 1–6, 3 personajes, 4 pasajes · 18k tokens
│ Lectura de la novela: 12/14 capítulos al día · [Actualizar (≈ 9k)]
│ ───────────────────────────────────────────────
│ [Pregúntale al Consejero…                    ] [Enviar]
└───────────────────────────────────────────────┘
```

- **Tipos de observación**, con etiqueta y color propios:
  - posible problema;
  - repetición;
  - posible contradicción;
  - cabo pendiente;
  - oportunidad narrativa;
  - alternativa para continuar;
  - ritmo o estructura.
- **Cada observación** lleva título, explicación, **confianza** (alta, media o baja) y **referencias**: cita y capítulo, con *Ir* que abre el capítulo y selecciona la cita, sin modificarla.
- **Acciones de una observación:** *Guardar*, *Descartar*, *Proponer hecho* (crea un hecho `suggested`), *Marcar cabo cerrado* y *Volver a comprobar*. **Ninguna escribe en el manuscrito.**
- **Respuesta:** texto libre en Markdown más observaciones estructuradas. El texto llega en streaming; las tarjetas aparecen al final, ya validadas.
- **Conversaciones** por novela: lista, continuar o nueva.
- **Sección *Cabos y lecturas***, dentro del Consejero: lista de cabos (confirmar, renombrar, fusionar, cerrar) y ficha de cada capítulo, editable, con su estado (al día, con retoques, desactualizada).
- **Personajes:** cada ficha muestra "última aparición: capítulo 9, hace 4 capítulos". Es un dato calculado, sin IA.
- **Móvil:** la misma estructura en la hoja inferior; las tarjetas a ancho completo.

**Convivencia con el Asistente.** Hoy el Asistente tiene tres acciones que ya son de análisis: *Consistencia*, *Personaje* y *Evolución*. Propongo **trasladarlas al Consejero** (sobre la selección) en la fase 4, de modo que el Asistente quede sólo para escribir (Redacción, Diálogo, Expandir, Acortar, Escribir escena). Lo dejo a tu decisión.

## 9. Cambios de base de datos

Todas las tablas nuevas siguen el patrón del esquema:

- `novel_id` con claves foráneas compuestas `(id, novel_id)`;
- RLS sin políticas y permisos revocados a `anon` y `authenticated`;
- `touch_row` para `updated_at`.

```sql
-- Ficha de cada capítulo (derivada; regenerable).
create table public.chapter_digests (
  chapter_id      uuid primary key,
  novel_id        uuid not null,
  source_revision integer not null,          -- revision del capítulo resumido
  paragraph_hashes text[] not null,          -- para distinguir retoque de reescritura
  summary         text not null,
  events          jsonb not null,            -- [{ text, character_ids, quote }]
  presence        jsonb not null,            -- [{ character_id, kind: present|mentioned }]
  revelations     jsonb not null,            -- [{ text, to: lector|character_id, quote }]
  thread_changes  jsonb not null,            -- [{ thread_id, change: opened|advanced|closed, quote }]
  notes           text not null default '',
  author_edited   boolean not null default false,
  model           text not null,
  created_at, updated_at,
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);

-- Cabos y conflictos de la novela.
create table public.story_threads (
  id, novel_id, title text, description text,
  kind   text check (kind in ('conflict','mystery','promise','relationship','other')),
  status text check (status in ('open','closed','abandoned')),
  opened_chapter_id uuid, last_chapter_id uuid, closed_chapter_id uuid,  -- FKs compuestas, set null
  origin text check (origin in ('advisor','author')),
  confirmed boolean not null default false,
  created_at, updated_at
);

-- Resumen global (uno por novela), con las revisiones de las que se derivó.
create table public.novel_digests (
  novel_id uuid primary key references public.novels(id) on delete cascade,
  summary text not null,
  based_on jsonb not null,                   -- { chapter_id: revision }
  model text not null, updated_at timestamptz
);

-- Conversaciones y mensajes del Consejero.
create table public.advisor_conversations (id, novel_id, title, summary text, created_at, updated_at);
create table public.advisor_messages (
  id, conversation_id, novel_id,
  role text check (role in ('author','advisor')),
  content text not null,                     -- Markdown
  context jsonb,                             -- qué se leyó: capítulos y revisiones, niveles, tokens
  created_at
);

-- Observaciones (tarjetas), para guardarlas, descartarlas y volver a comprobarlas.
create table public.advisor_observations (
  id, novel_id, message_id,
  kind text check (kind in ('problem','repetition','contradiction','thread','opportunity','alternative','pacing')),
  title text, body text, confidence text check (confidence in ('high','medium','low')),
  refs jsonb not null,                       -- [{ chapter_id, quote, verified }]
  based_on jsonb not null,                   -- { chapter_id: revision }
  status text check (status in ('new','saved','dismissed','resolved')),
  created_at, updated_at
);

-- Uso de IA, para controlar el coste.
create table public.ai_usage (
  id, novel_id, purpose text,                -- assist | advise | digest | plan
  provider text, model text,
  input_tokens integer, cached_tokens integer, output_tokens integer,
  created_at
);
```

- **Sin cambios en `chapters`, `characters` ni `facts`:** se reutiliza `facts.status = 'suggested'`.
- **`duplicate_novel`:**
  - copia fichas, cabos y resumen global con ids reasignados, porque son caros de regenerar;
  - las conversaciones, observaciones y uso no se copian, porque son el historial de esa novela.
- **Borrar una novela o un capítulo** limpia todo en cascada. Los cabos que apuntaban a un capítulo borrado se quedan con ese campo a `null`.

## 10. Fases

| Fase | Contenido | IA nueva |
|---|---|---|
| **1 · Base sin IA** | Índice de menciones y estadísticas (última aparición, presencia por capítulo), informe léxico de repeticiones, mapa de la novela. Pestañas *Asistente / Consejero* en el panel. Proveedores con roles, salida estructurada validada y registro de uso (`ai_usage`). | Ninguna |
| **2 · Lectura de la novela** | `chapter_digests`, `story_threads`, `novel_digests`; vigencia por revisión y hash de párrafos; generación perezosa con estimación; sección *Cabos y lecturas* editable. | Fichas y global, con el modelo económico |
| **3 · Acciones del Consejero** | Recetas de contexto y planificador determinista; *Analizar capítulo*, *¿Cómo seguir?*, *Repeticiones*, *Cabos pendientes*, *Coherencia*, *Personajes*; tarjetas tipificadas con citas verificadas e *Ir al texto*. | Respuestas del Consejero |
| **4 · Conversación** | Conversaciones persistentes con compactación; guardar y descartar observaciones; *Proponer hecho* (hecho `suggested`); acciones sobre cabos; *Volver a comprobar* tras editar. Opcional: trasladar *Consistencia, Personaje y Evolución* del Asistente. | — |
| **5 · Lectura profunda** | Herramientas de sólo lectura para que el modelo pida fichas, pasajes o capítulos (con topes); análisis de la novela completa con caché; integración con la Cronología cuando exista. | Consultas con herramientas |

Cada fase es usable por sí misma. La 1 ya responde sin coste "¿hace cuánto que no aparece X?" y "¿qué expresiones repito?".

## Decisiones tomadas

1. **Separación:**
   - **Asistente = escribe conmigo:** genera, desarrolla, transforma o mejora texto (Redacción, Diálogo, Expandir, Acortar, Escribir escena).
   - **Consejero = piensa conmigo sobre la novela:** análisis, coherencia, personajes, evolución, trama, ritmo, repeticiones, cabos y posibilidades narrativas.
   - *Consistencia*, *Personaje* y *Evolución* **se trasladan al Consejero**.
2. **Fichas de capítulo:**
   - Actualización automática **sólo ante cambios sustanciales** y **nunca durante la escritura**. Un cambio sustancial marca la ficha como desactualizada; se regenera al abandonar el capítulo o cuando el Consejero la necesita, sin interferir con la escritura.
   - Las pequeñas modificaciones no llaman a la IA.
   - Hay un **interruptor** para desactivar la automatización.
   - El manuscrito es siempre la fuente de verdad.
3. **Modelos:** se configuran por separado el **modelo de escritura**, el **del Consejero** y el **económico de análisis y resúmenes**. Al principio pueden coincidir con el proveedor y modelo disponibles; la separación queda preparada para cambiarlos.
4. **Coste y tokens:**
   - **Sin confirmación** en las consultas normales.
   - Se muestra, de forma discreta, qué contexto se usó, los tokens y, cuando sea posible, el coste estimado o real.
   - Sólo se pide confirmación en operaciones excepcionalmente grandes que superen un **umbral configurable**, como la lectura profunda de una novela extensa.
   - Esto sustituye la confirmación previa de las secciones 3 y 7.
5. **Evidencia:** las observaciones deben ser verificables (pendiente de completar con el resto de la indicación del autor).
