# Consejero literario

> Estado: **diseño aprobado. Fases 1 a 5 implementadas** (ver "Estado de la implementación", al final). Decisiones del autor en "Decisiones tomadas", al final; prevalecen sobre el resto del documento.

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
| **1 · Base sin IA** | Índice de menciones y estadísticas (última aparición, presencia por capítulo), informe léxico de repeticiones, mapa de la novela. Pestañas *Asistente / Consejero* en el panel, con *Consistencia, Personaje y Evolución* ya en el Consejero. Proveedores con roles y registro de uso (`ai_usage`). **Hecha.** | Ninguna |
| **2 · Lectura de la novela** | `chapter_digests`, `story_threads`, `novel_digests`; vigencia por revisión y hash de párrafos; generación perezosa con estimación; sección *Cabos y lecturas* editable. **Hecha.** | Fichas y global, con el modelo económico |
| **3 · Acciones del Consejero** | Recetas de contexto y planificador determinista; *Analizar capítulo*, *¿Cómo seguir?*, *Repeticiones*, *Cabos pendientes*, *Coherencia*, *Personajes*; tarjetas tipificadas con citas verificadas e *Ir al texto*. **Hecha.** | Respuestas del Consejero |
| **4 · Conversación** | Conversaciones persistentes con compactación; guardar y descartar observaciones; *Proponer hecho* (hecho `suggested`); acciones sobre cabos; *Volver a comprobar* tras editar. **Hecha.** | — |
| **5 · Lectura profunda** | Herramientas de sólo lectura para que el modelo pida fichas, pasajes o capítulos (con topes); análisis de la novela completa con caché; integración con la Cronología cuando exista. **Hecha** (salvo la Cronología, que aún no existe). | Consultas con herramientas |

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
5. **Evidencia:**
   - Las observaciones deben ser verificables. Cuando el Consejero señale una repetición, contradicción, problema de coherencia, cabo pendiente u otra observación basada en el manuscrito, muestra las referencias o citas siempre que sea posible.
   - Las referencias son **pulsables** y llevan al fragmento del manuscrito.
   - **Nunca se inventa una cita.** Si una observación no puede verificarse directamente en el texto, se indica con claridad.
6. **¿Cómo seguir?:** el Consejero **no continúa escribiendo**. Propone varios caminos razonables y explica brevemente qué aprovecha cada uno. Por ejemplo: continuar el conflicto actual, recuperar un cabo anterior, cambiar temporalmente de personaje, o introducir una consecuencia de algo ya ocurrido. El autor elige; si quiere desarrollar una alternativa, la envía al Asistente.
7. **No duplicar la Memoria:** no se crean copias de lo que ya pertenece a Personajes, Relaciones, Hechos, Lugares o la Guía Maestra. Las fichas del Consejero son índices y resúmenes de lectura, no una segunda Memoria.
8. **Fases:** se implementa por fases (sección 10), cada una con sus pruebas, sin pasar a la siguiente con regresiones en la anterior.

## Estado de la implementación

### Fase 1 · Base sin IA (implementada)

- **Panel con dos secciones**, *Asistente* y *Consejero*, con un botón para cada una en la barra superior.
  - El Asistente conserva *Redacción, Diálogo, Expandir, Acortar* y *Escribir escena*.
  - El Consejero tiene dos vistas:
    - *Sobre la selección*, con *Consistencia, Personaje* y *Evolución* (trasladadas);
    - *Panorama*.
- ***Panorama***, calculado en el servidor sin IA ni almacenamiento (`src/lib/advisor/stats.ts`, `POST /api/novels/{id}/advisor`). Usa el texto abierto aunque no esté guardado y se recalcula al abrirlo o con *Actualizar*, nunca mientras se escribe. Muestra:
  - **Personajes:** última aparición, medida desde el capítulo abierto: hace cuántos capítulos y cuántas palabras. Primero los que llevan más tiempo ausentes; también los que aún no aparecen.
  - **Repeticiones** del capítulo y entre capítulos:
    - frases de 3 o más palabras con al menos dos palabras de contenido; una repetición larga se informa una sola vez y entera, no en trozos;
    - ecos: la misma palabra de contenido a menos de unas 40 palabras de distancia, sin contar nombres ni palabras funcionales.
  - **Evidencia en cada repetición:** cada aparición lleva su fragmento y un botón ***Ir*** que la selecciona en el editor, abriendo otro capítulo si hace falta. Si el texto cambió, selecciona la aparición más cercana.
  - **Mapa de la novela:** capítulos, palabras y quién y dónde aparece.
  - **Uso de la IA** en el mes.
- **Un modelo por función:**
  - `{PROVEEDOR}_MODEL` para la escritura;
  - `{PROVEEDOR}_MODEL_ADVISE` para el Consejero;
  - `{PROVEEDOR}_MODEL_DIGEST` para el análisis económico.

  Si una función no tiene modelo propio, usa el de escritura (`src/lib/ai/models.ts`). Las tres acciones de análisis ya usan el modelo del Consejero.
- **Uso y coste:**
  - Cada proveedor informa del uso real: entrada, en caché y salida.
  - La respuesta empieza con el contexto enviado, por partes. Bajo el resultado se ve una línea discreta: «Leyó: … · tokens de entrada (en caché) → salida · ≈ US$».
  - Cada consulta queda en `ai_usage`. Esa tabla no se copia al duplicar una novela y se borra con ella.
  - El coste aparece sólo si hay precios en `AI_PRICES`: no se incluyen precios en el código porque cambian.
  - Las consultas normales ya no piden confirmación. Sólo la piden las que superan `AI_CONFIRM_TOKENS` (150.000 por defecto).
- **Aplazado:** la salida estructurada validada (JSON) pasa a la Fase 2, donde la usan por primera vez las fichas.
- **Pruebas:**
  - unitarias de estadísticas, repeticiones, modelos por función, precios y uso por proveedor;
  - E2E de `tests/e2e/advisor.test.mjs`: Panorama, eventos de contexto y uso, filas de `ai_usage`, aislamiento, interfaz e *Ir* entre capítulos.

### Fase 2 · Lectura de la novela (implementada)

- **Tablas nuevas** (`supabase/schema.sql`):
  - `chapter_digests`, `story_threads` y `novel_digests`, con el patrón habitual: aislamiento por novela, RLS y sin acceso público;
  - `novels.auto_digest`, el interruptor.

  Todo es derivado: el manuscrito manda, y las fichas citan a los personajes por id sin copiar nada de la Memoria (decisión 7). Al duplicar una novela se copian fichas, cabos y resumen con ids nuevos; las referencias internas se reescriben y la vigencia se conserva.
- **Ficha de capítulo** (`POST /api/chapters/{id}/digest`):
  - la hace el modelo económico (`role: "digest"`) leyendo el texto guardado;
  - contiene resumen, acontecimientos, presencia (en escena o nombrado), revelaciones, cabos que abre, hace avanzar o cierra, y una nota de ritmo;
  - cada consulta se registra en `ai_usage` con `purpose = 'digest'`.
- **Salida estructurada validada** (`src/lib/ai/structured.ts`, `src/lib/advisor/digest-schema.ts`):
  - el modelo responde en JSON y el servidor lo valida siempre;
  - si la estructura es inválida, reintenta una vez indicando el error; si vuelve a fallar, responde 502 y **no guarda nada** (la ficha anterior se conserva);
  - es el mismo mecanismo para los tres proveedores, así que *Probar con* sigue funcionando. El modo JSON nativo de cada API queda como mejora posible.
- **Citas verificadas** (`src/lib/advisor/quotes.ts`, decisión 5):
  - cada cita se busca en el texto real; la comparación ignora mayúsculas, espacios, tipo de comillas y guiones, y puntos suspensivos;
  - se guarda tal como está en el texto. Una cita que no aparece **nunca se guarda como cita**: el panel muestra «sin cita verificable»;
  - las citas encontradas llevan *Ir*, que abre el capítulo y selecciona el fragmento. Si el texto cambió y la cita ya no está, el panel lo dice y la ficha pasa a desactualizada.
- **Vigencia sin IA** (`src/lib/advisor/freshness.ts`):
  - estados: *al día*, *con retoques*, *desactualizada* y *sin leer*;
  - en vez de un hash por párrafo, la ficha guarda una **huella del texto**: las secuencias de tres palabras, de las que se conservan los 256 hashes menores (estimación *bottom-k*). Así una errata en un párrafo largo, o en un capítulo de un solo párrafo, no cuenta como reescritura. Hasta unas 250 palabras la medida es exacta;
  - un cambio es **sustancial** si supera el 15 % del texto y toca al menos 40 palabras, o si añade más de 300 palabras;
  - variables: `DIGEST_CHANGE_PCT`, `DIGEST_CHANGE_MIN_WORDS` y `DIGEST_CHANGE_WORDS`.
- **Automatización** (decisión 2):
  - al **dejar un capítulo en el que se escribió**, el navegador avisa al servidor en segundo plano, y el servidor decide;
  - lee el capítulo sólo si el cambio fue sustancial, o si el capítulo nunca se leyó y tiene al menos 300 palabras;
  - nunca relee sobre una corrección del autor ni por encima del umbral de confirmación;
  - mientras se escribe no hay ninguna llamada, y los retoques no llegan a la IA;
  - el interruptor está en *Cabos y lecturas*.
- **Cabos** (`story_threads`):
  - los que propone la lectura aparecen como *posible cabo* hasta que el autor los confirma;
  - apertura, última aparición y cierre se **derivan de las fichas**, en orden de capítulos. Si un capítulo releído ya no cierra un cabo, el cabo vuelve a *abierto*;
  - un posible cabo que ya no menciona ninguna ficha desaparece;
  - el autor puede confirmar, renombrar, cerrar, abandonar, reabrir, devolver el estado a la lectura (*Según la lectura*), fusionar (las referencias pasan al otro cabo), eliminar y añadir;
  - un estado que fija el autor no lo cambia una relectura.
- **Correcciones del autor:**
  - el resumen de una ficha se puede corregir; la corrección prevalece y la automatización no la pisa;
  - releer a mano pide confirmación;
  - si el capítulo cambia, el panel avisa: «tu corrección puede haber quedado vieja».
- **Resumen global** (`POST /api/novels/{id}/digest`):
  - se hace con las fichas, no con el texto;
  - queda desactualizado cuando alguna ficha cambia;
  - las fichas desactualizadas se le envían marcadas como «versión anterior».
- **Vista *Cabos y lecturas*** (Consejero):
  - cuántos capítulos están al día;
  - *Actualizar la lectura*, con la estimación de tokens: lee uno a uno lo pendiente y después rehace el resumen global. Muestra el progreso, se puede detener y sólo pide confirmación por encima de `AI_CONFIRM_TOKENS`;
  - el resumen global, los cabos y la ficha de cada capítulo con su estado.
- **Pruebas:**
  - unitarias de citas, vigencia (retoque, reescritura, inserción larga, cita perdida, capítulo breve y estimación en textos largos), validación del esquema y extracción del JSON;
  - E2E de `tests/e2e/reading.test.mjs`: fichas con el modelo económico, citas reales e inventadas, reintento y fallo sin guardar, vigencia, automatización, correcciones, cabos (incluida la fusión y el aislamiento entre novelas), resumen global, duplicado, borrado, la vista y la relectura al cambiar de capítulo.

### Fase 3 · Acciones del Consejero (implementada)

- **Vista *Consultar*** (la primera del Consejero):
  - seis acciones: *Analizar capítulo*, *¿Cómo seguir?*, *Repeticiones*, *Cabos pendientes*, *Coherencia* y *Personajes*;
  - un cuadro para preguntar libremente;
  - con una selección en el editor, *Analizar* y *Coherencia* pueden trabajar sobre ella.

  La respuesta es consejo: ninguna acción escribe en el manuscrito.
- **Recetas de contexto por niveles** (`src/lib/advisor/advice.ts`, §4):
  - **marco estable**: Guía, sinopsis del autor, mapa de la novela con una línea de cada ficha, resumen global y cabos. Es igual en todas las acciones y se marca como caché en Claude;
  - **foco**: el capítulo abierto completo y vivo, con lo no guardado; o la selección y su entorno; o el final del capítulo para *¿Cómo seguir?* y *Cabos*;
  - **Memoria pertinente** y **fichas** de los capítulos anteriores y de aquellos donde están los personajes implicados, con presupuesto. Las desactualizadas van marcadas como «versión anterior»;
  - **pasajes** por personaje, por la cita ancla de cada cabo y por las palabras de la pregunta;
  - **capítulos completos** cuando la pregunta los nombra;
  - **datos calculados**: última aparición de cada personaje, informe de repeticiones y cabos abiertos con los capítulos que llevan sin aparecer.

  Cada receta tiene su presupuesto de entrada, y la salida se limita a 4.000 tokens.
- **Planificador determinista** (`src/lib/advisor/planner.ts`):
  - reconoce personajes y lugares (con sus apodos), capítulos por número o título, cabos por título y palabras de intención;
  - elige la receta más cercana. El panel muestra cómo entendió la pregunta («Entendí la pregunta como: Coherencia · personajes: Elena · capítulos: 1») antes de la respuesta.
- **Fichas que faltan** («cuando el Consejero la necesite», decisión 2): si la receta usa capítulos sin ficha o con una desactualizada, el panel los lee primero, mostrando el progreso, y después responde. Sólo pide confirmación si el total supera `AI_CONFIRM_TOKENS`. Las fichas que el autor corrigió no se tocan.
- **Respuesta y tarjetas** (`src/lib/advisor/observations.ts`):
  - el texto llega en streaming, en Markdown, y al final el servidor valida las observaciones (bloque `<observaciones>` en JSON) y verifica cada referencia en el manuscrito;
  - una cita que está en otro capítulo del que dijo el modelo se corrige;
  - una que no está en ninguna parte se muestra como «no aparece en el texto» y baja la confianza un nivel;
  - una tarjeta sin ninguna cita verificada se presenta como **impresión**, no como hallazgo (decisión 5);
  - si el JSON llega roto, el texto se conserva y el panel lo indica;
  - cada tarjeta lleva tipo (con color), título, explicación, confianza y referencias con *Ir*.
- ***¿Cómo seguir?*** (decisión 6):
  - propone de 3 a 4 caminos como tarjetas «Alternativa para continuar», cada uno con lo que aprovecha de lo escrito;
  - las instrucciones prohíben escribir la continuación;
  - *Enviar al Asistente* pone la alternativa como argumento de *Escribir escena*; el autor decide si la desarrolla.
- **Proveedores:**
  - `CompletionRequest` gana `maxOutputTokens` y `cacheProject`;
  - en Claude ya no se envía un bloque de sistema vacío cuando no hay proyecto. Corrige las fichas de la fase 2, que lo enviaban;
  - *Probar con* repite la consulta con otro proveedor.
- **Aplazado a la fase 4:** guardar y descartar observaciones, *Proponer hecho* y *Volver a comprobar*. En esta fase las respuestas no se guardan; sólo su uso queda en `ai_usage`.
- **Pruebas:**
  - unitarias del planificador y de la verificación de observaciones;
  - E2E de `tests/e2e/advice.test.mjs`: niveles del contexto, capítulos sin ficha, validación, modelo del Consejero y caché del marco, texto vivo, fichas en orden, datos calculados, pasajes de cabos, preguntas libres con capítulos nombrados, selección, JSON roto, la vista con *Ir*, la pregunta libre, *Enviar al Asistente* y la lectura previa de fichas.

### Fase 4 · Conversación (implementada)

- **Tablas nuevas:** `advisor_conversations`, `advisor_messages` y `advisor_observations`, con aislamiento por novela, RLS y sin acceso público. No se copian al duplicar: son el historial de esa novela.
- **Conversaciones** (`src/lib/advisor/conversations.ts`):
  - cada pregunta o acción de *Consultar* se guarda como un intercambio: el turno del autor, la respuesta del Consejero en Markdown (sin el bloque JSON), lo que leyó, el plan y el uso;
  - la primera pregunta abre una conversación con ese título; las siguientes la continúan;
  - el panel tiene un selector de conversaciones, *Nueva* y *Eliminar*, y recuerda por novela la que estaba abierta.
- **Compactación:**
  - a cada consulta van literales los últimos tres intercambios;
  - los anteriores se resumen con el **modelo económico** (registrado como `digest`) en cuanto salen de esa ventana, y el resumen va como «Resumen de lo hablado antes»;
  - la compactación ocurre al hacer la pregunta siguiente, nunca en una estimación (`dryRun`).
- **Observaciones guardadas:**
  - cada tarjeta se guarda con estado (*nueva*, *guardada*, *descartada* o *resuelta*), su orden, sus referencias verificadas y `based_on`, las revisiones de los capítulos en que se apoya: el foco, los capítulos leídos completos y los de sus citas;
  - antes de cada consulta se guarda el capítulo abierto, para que la revisión registrada sea la del texto leído;
  - acciones: *Guardar*, *Descartar* (queda plegada y se puede *Restaurar*), *Marcar resuelta* y *Reabrir*;
  - la vista **Guardadas** lista las pendientes y las resueltas;
  - al eliminar una conversación se conservan las observaciones guardadas, sin su mensaje.
- **Volver a comprobar** (§6):
  - si cambió un capítulo en que se apoya, la tarjeta dice «Basada en una versión anterior del capítulo N»;
  - *Volver a comprobar* busca otra vez sus citas en el texto actual, sin IA: las que siguen quedan verificadas y la observación pasa a apoyarse en las revisiones nuevas; las que ya no están se marcan;
  - *Preguntar de nuevo* le pide al Consejero, en la misma conversación, que la reconsidere con el texto actual.
- **Proponer hecho** (tarjetas de problema, contradicción o cabo):
  - abre un formulario con el texto propuesto, que el autor puede editar, y lo añade a la Memoria como hecho `suggested`, con el capítulo de su primera cita verificada y los personajes que nombra;
  - en *Memoria → Hechos* aparece como «Sugerido por el Consejero, sin aprobar», con una casilla para aprobarlo;
  - mientras no se aprueba, ni el Asistente ni el Consejero lo usan como canon;
  - la API de hechos acepta y valida `status`.
- **Acciones sobre cabos** (tarjetas de cabo): si la observación nombra un cabo existente y abierto, *Marcar cabo «…» cerrado* (estado decidido por el autor); si no, *Crear cabo*.
- **Ninguna acción escribe en el manuscrito.**
- **Pruebas:** E2E de `tests/e2e/conversation.test.mjs`: intercambios guardados y su orden, continuación con los turnos anteriores, compactación con el modelo económico, aislamiento, estados de las observaciones, «versión anterior» y *Volver a comprobar*, hechos sugeridos fuera del canon hasta aprobarse, borrado y duplicado, y en el panel: conversación, *Guardar*, *Descartar*, seguimiento, selector, *Guardadas*, *Volver a comprobar*, *Proponer hecho* y las acciones sobre cabos.

### Fase 5 · Lectura profunda (implementada)

**Principio:** leer lo necesario, no la novela. La primera respuesta parte siempre del contexto jerárquico (fases 3 y 4). Sólo si el modelo descubre que le falta algo, pide material concreto. El servidor se lo da dentro de límites y vuelve a preguntar.

- **Protocolo independiente del proveedor** (`src/lib/advisor/deep.ts`, `loop.ts`):
  - en vez de responder, el modelo escribe sólo un bloque `<solicitar>[{ "tipo": …, … }]</solicitar>`;
  - el servidor lo detecta, sirve el material en `<material ronda="N">` y repite la consulta;
  - es texto plano, sin la llamada a herramientas propia de cada API, así que funciona igual con Claude, GPT, Grok o cualquier otro modelo;
  - mientras el texto que llega puede ser un pedido, el servidor lo retiene. Si el modelo escribió algo y después pidió, el panel recibe `reset` y lo borra: el autor sólo ve la respuesta final.
- **Herramientas, todas de sólo lectura** (ninguna puede modificar el manuscrito ni regenerar fichas):

  | Pedido | Devuelve | Coste |
  |---|---|---|
  | `ficha` (capítulo) | Ficha guardada tal como está, con las correcciones del autor; marcada si es de una versión anterior | Bajo |
  | `pasajes` (palabras, personaje, capítulos) | Hasta 8 párrafos literales de toda la novela, por puntuación léxica y por nombre o apodo, en el orden de la novela | Bajo |
  | `revelaciones` (personaje) | Qué se reveló, a quién y dónde, según las fichas | Bajo |
  | `personaje` (nombre) | Su ficha de Memoria, en qué capítulos aparece y los acontecimientos en que participa (el arco reconstruido de las fichas) | Bajo |
  | `hechos` (personaje) | Sólo hechos **aprobados**; los sugeridos no son canon | Bajo |
  | `relaciones` (personaje) | Relaciones de la Memoria | Bajo |
  | `cabo` (título) | El cabo y los párrafos donde se abre, avanza o se cierra | Bajo |
  | `capitulo` (número) | El texto completo, recortado a un tamaño máximo | **Alto**: sólo si lo demás no basta |

- **Cómo decide el modelo:**
  - las instrucciones le dicen que lo que recibe es una selección;
  - que pida sólo si no puede responder con rigor, y primero fichas y pasajes;
  - que pida un capítulo completo sólo si es imprescindible, y nunca la novela;
  - si ya tiene lo necesario, responde sin pedir.
- **Límites por consulta** (configurables):

  | Límite | Variable | Valor por defecto |
  |---|---|---|
  | Rondas de pedidos | `DEEP_MAX_ROUNDS` | 3 |
  | Pedidos por ronda | `DEEP_MAX_REQUESTS` | 6 |
  | Material añadido | `DEEP_MAX_MATERIAL_TOKENS` | 40.000 tokens |
  | Capítulos completos | `DEEP_MAX_CHAPTERS` | 2 |
  | Tamaño de cada capítulo | `DEEP_CHAPTER_TOKENS` | 20.000 tokens |
  | Coste, si hay precios en `AI_PRICES` | `DEEP_MAX_COST_USD` | 0,50 |

  Un pedido repetido no se sirve dos veces. La última ronda le indica al modelo que responda con lo que tiene y diga qué no pudo comprobar. Si aun así pide, el panel muestra que no se completó la lectura: no hay bucles.
- **Confirmación extraordinaria:**
  - antes de cada ronda, el servidor suma lo que ya se envió (cada ronda reenvía el contexto) más lo que enviaría;
  - si supera `AI_CONFIRM_TOKENS` y el autor no lo aprobó, se detiene sin guardar nada y avisa (`confirm`) con los tokens y lo ya pedido;
  - si el autor acepta, la consulta se repite con ese material precargado (`preload`) y aprobado (`approvedTokens`): no vuelve a pagar la ronda en la que pidió.
- **Trazabilidad:**
  - cada ronda se registra en `ai_usage` y el uso que ve el autor es la suma de todas;
  - el panel muestra cada ronda mientras ocurre y, bajo la respuesta, una línea discreta: «Consultó además: pasajes «mar» · Elena (2) — ≈43 tokens en 1 ronda». Queda guardada con el mensaje.
- **Verificación y vigencia:**
  - las citas se siguen verificando contra el manuscrito real, el material incluido;
  - las observaciones guardan en `based_on` también las revisiones de los capítulos leídos en profundidad. Si cambia el capítulo 3 consultado desde el 27, la observación dice «basada en una versión anterior del capítulo 3».
- **Novelas largas:**
  - el marco crece unos 40 tokens por capítulo, y el resto de cada consulta está acotado por recetas y límites;
  - una prueba con 120 capítulos (1,66 millones de caracteres, unas 1.000 páginas) envía unos 24.000 caracteres por ronda (1,5 %) y prepara la consulta en unos 300 ms;
  - el servidor sí lee de la base todos los capítulos en cada consulta, para el mapa, las búsquedas y la verificación de citas. Si eso llegara a pesar, el siguiente paso sería un índice de párrafos en la base, sin cambiar el protocolo.
- **Interruptor:** *Lectura profunda* en *Consultar*, activado por defecto. Sin él, el Consejero responde sólo con el contexto jerárquico.
- **Pruebas:**
  - unitarias de cada herramienta y de los límites (novela de 30 capítulos);
  - E2E de `tests/e2e/deep.test.mjs`, con una novela de 28 capítulos:
    - capítulo 3 ↔ 27 (contradicción citada en ambos y verificada);
    - un personaje ausente desde el capítulo 2, con dos rondas;
    - una revelación reciente contra un hecho del capítulo 4;
    - correcciones del autor servidas sin pisarse;
    - el límite de rondas;
    - el texto retirado antes de un pedido;
    - sin lectura profunda;
    - la pausa con su reanudación;
    - una novela de 120 capítulos;
    - el panel con la línea de material y las confirmaciones.


## Consejero creativo (coautor)

El Asistente escribe contigo; el Consejero piensa contigo. El «coautor» no es una tercera IA: es el
mismo Consejero, con recetas creativas y una conversación que recuerda sus propuestas. **Procesador
propone; el autor decide.**

### Fase 1 · Conversación creativa (implementada, sin cambios de base de datos)

- **Recetas nuevas** (`advice.ts`, `prompts.ts`):

  | Acción | Qué hace | Lee además |
  |---|---|---|
  | *¿Cómo continúo?* (`seguir`) | Exactamente 3 caminos, A/B/C, para lo que viene | presencia, cabos, secretos |
  | *3 caminos* (`caminos`) | 3 direcciones para la historia (pueden abarcar varios capítulos) | igual |
  | *¿Qué pasa si…?* (`consecuencias`) | Consecuencias de una hipótesis: a quién afecta, qué revela, qué contradice, cabos, corto y largo plazo | fichas, relaciones (con quien esté al otro lado) y hechos de los nombrados |
  | *Necesito un giro* (`giro`) | 3 giros construidos sólo con lo que existe | secretos y «no sabe» de la Memoria, cabos |
  | *Busca oportunidades* (`oportunidades`) | 3–5 oportunidades que la novela ya ofrece | igual |
  | *Subir tensión* (`tension`) | Diagnóstico y 2–4 formas de subirla (también sobre la selección) | cabos, secretos |
  | (sin botón) `explorar` | Desarrollar una propuesta de la conversación, o seguir la conversación | la propuesta en curso |

  - Cada camino: qué podría ocurrir, por qué funciona en esta novela, qué aprovecha, consecuencias,
    riesgos y personajes. Vienen como campos del JSON y el servidor los guarda dentro del cuerpo
    de la tarjeta, una línea por sección (`observations.ts`), sin columnas nuevas. Las citas se
    verifican como siempre.
  - Las respuestas creativas tienen más espacio (hasta 6.000 tokens de salida y de 100 a 450
    palabras de texto, según la receta); las analíticas siguen igual. Nunca una escena: describe,
    no escribe.
  - El planificador reconoce «no sé cómo continuar», «dame 3 caminos», «¿qué pasa si…?», «y si…»,
    «necesito un giro», «busca oportunidades», «quiero subir la tensión». *Personajes
    desaprovechados* como receta creativa (potencial sin usar, reintroducción) es de la fase 3;
    hasta entonces sigue *Personajes*, en *Revisar*.

- **Cronología en el contexto:** el tiempo del relato en el capítulo abierto (el «ahora») y la
  edad de cada personaje en ese punto, en sus fichas, como en el Asistente; además, un bloque
  `<cronologia>` con el tiempo de cada capítulo (marcando el abierto, los posteriores y las
  retrospectivas) y los avisos de cronología.

- **Tarjetas con etiqueta** (`cards.ts`, funciones puras compartidas por servidor y panel):
  - cada tarjeta de una conversación tiene una etiqueta estable: A, B, C… en el orden en que se
    propusieron, nunca reutilizadas. Lo que desarrolla una propuesta es una versión: B2, B3… B
    queda como estaba. Se guardan en `advisor_messages.context.cards` (las conversaciones
    anteriores reciben letras en orden al leerse);
  - **referencias sin IA:** «la B», «camino b», «B» (la letra); «el segundo», «la tercera opción»,
    «camino 2» (el orden en la respuesta más reciente que tenga esas tarjetas); «el último»,
    «el penúltimo». Un ordinal que nombra otra cosa («el segundo capítulo», «la primera vez») no
    cuenta. Lo que no se resuelve lo ve el modelo con todas las tarjetas y su etiqueta, con la
    regla de preguntar si no está claro;
  - **Seguir con esta** (botón en caminos y oportunidades): el mensaje va anclado a esa tarjeta
    por su id; el botón manda sobre las palabras. Una tarjeta de otra conversación se rechaza;
  - **la propuesta en curso:** un mensaje sin referencia («pero que aparezca Nacho», «no, mejor
    sin Nacho») sigue con la última propuesta anclada, en su versión más reciente (B → B2 → B3).
    No la hereda si nombra otra tarjeta, pide algo nuevo (caminos, oportunidades, cabos,
    repeticiones, coherencia), dice «otra cosa» o «cambiemos de tema», o si el autor pulsa
    *Soltar*. El panel lo muestra encima del campo («Desarrollando B2 · Soltar») y en el plan
    («sobre B2 … (la que estamos desarrollando)»);
  - el turno del autor guarda su ancla en `advisor_messages.context.anchor` (id, etiqueta, título
    y cómo se entendió).

- **Estados**, calculados de lo que hizo el autor, nunca de un resumen: **PROPUESTO**, **ELEGIDO
  PARA EXPLORAR** (un mensaje anclado a ella), **MODIFICADO** (tiene versiones: «→ B2»),
  **DESCARTADO** (su estado `dismissed`: con *Descartar*, o diciendo «descarta la C»; elegirla
  otra vez por su nombre la recupera). Guardar una tarjeta no la decide: sigue siendo una idea.

- **Protección del canon:**
  - las instrucciones del Consejero dicen que la conversación no es una fuente de hechos: lo
    propuesto, elegido o modificado no ha ocurrido; lo descartado no se vuelve a proponer ni se
    trata como verdad; algo sólo entra en la novela si el autor lo escribe o aprueba un hecho;
  - en cada consulta, después del resumen y de los últimos mensajes, va el **estado actual de
    las tarjetas**, recalculado («manda sobre el resumen»), con la frase «Ninguna es un hecho de
    la novela». De las descartadas va sólo el título, marcado «no es verdad en la novela»;
  - la **compactación** recibe los mensajes con sus etiquetas y los estados correctos, y tiene la
    orden de conservarlos con esas cuatro palabras y de no escribir nunca que algo ocurre en la
    novela por haberse hablado. El resumen se presenta al Consejero como «ideas en discusión;
    nada de esto es un hecho de la novela», dentro de `<conversacion>`, nunca junto a la Memoria;
  - la propuesta en curso va en `<propuesta-en-curso>`, marcada como posibilidad;
  - ninguna acción del Consejero escribe en el manuscrito, la Memoria, los hechos ni los cabos.
    Lo único que cambia una frase del autor es el estado de una tarjeta (descartar o recuperar).
    En las propuestas no hay *Proponer hecho*: convertir una idea en hecho es de la fase 2.

- **Interfaz** (*Consultar*): dos líneas de enlaces discretos, *Pensar juntos* y *Revisar*, en vez
  de la fila de botones; *¿Qué pasa si…?* sólo empieza la pregunta. Las tarjetas muestran su
  etiqueta («Camino B», «B2 · versión de B») y las secciones de cada camino; el turno del autor,
  sobre qué tarjeta era. *Enviar al Asistente* manda qué ocurriría y quiénes, no las razones ni
  los riesgos.

- **Modelos y coste:** sin cambios. El Consejero usa su modelo (`*_MODEL_ADVISE`) y la
  compactación el económico (`*_MODEL_DIGEST`); todo se registra en `ai_usage`.

- **Límites hasta la fase 2:** las ideas viven dentro de su conversación (las guardadas se ven en
  *Guardadas*, pero no vuelven al contexto de otras conversaciones); no hay planes («decidido,
  aún no escrito»), ni *Hacer plan*, *Hacer hecho* desde una idea, *Ya está escrito*, ni vista
  *Ideas*; descartar «una parte» («sin Nacho») se refleja como una versión nueva, no como un
  estado de la parte.

### Conversar: el Consejero como compañero (implementado, sin cambios de base de datos)

Probado con una novela real, el Consejero creativo respondía como un informe: tres caminos con seis
secciones, observaciones, riesgos y preguntas, incluso cuando el autor ya había decidido. Ahora
*Consultar* tiene dos modos, **Conversar** (predeterminado) y **Analizar** (todo lo anterior,
intacto). Es el mismo Consejero: mismas conversaciones, etiquetas, referencias, foco y protección
del canon.

- **Conversar** (`CONVERSE_INSTRUCTIONS`, `CONVERSE_TASKS`, en `prompts.ts`):
  - un amigo escritor: natural, cálido y concreto; normalmente breve, sin límite rígido cuando se
    pide desarrollar;
  - una propuesta principal, como mucho, en el bloque `<observaciones>` de siempre (así funcionan las
    etiquetas, «Seguir con esta», guardar y la verificación de citas); varias sólo con «dame
    opciones»;
  - las decisiones del autor son su plan: no se discuten; sólo si contradicen el canon (manuscrito o
    hecho aprobado) se avisa en una frase con la referencia y una solución;
  - no analiza el capítulo ni hace listas de riesgos salvo que se pida;
  - contexto ligero: el final del capítulo, la Memoria pertinente, la cronología, el marco y la
    conversación; sin tablas de presencia ni repeticiones; una ronda de lectura profunda; hasta
    3.000 tokens de salida.
- **Intenciones sin IA** (`converse.ts`, compartido por servidor y panel):
  - «me gusta», «esa quiero», «desarróllala»: la propuesta en curso o la última propuesta (se ve
    «sobre A (la que acabo de proponer)»);
  - «dame opciones»: varias;
  - «analiza…», «revisa la coherencia…»: ese turno en Analizar, sin heredar la propuesta en curso;
  - «envíala al Asistente» y «guárdala»: actúan sobre la propuesta en la mesa sin preguntar al modelo.
- **El plan de la conversación:** las decisiones («quiero que…», «he decidido que…») y lo descartado
  («sin Nacho», «no quiero que…») se guardan con las palabras del autor en el contexto de su mensaje
  (`advisor_messages.context.decisions/discarded`). Un descarte que nombra a alguien retira la
  decisión anterior sobre él. El plan va siempre al modelo como «PLAN: decidido por el autor, aún no
  escrito ni canon», recalculado (no del resumen), y la compactación lo conserva. En el panel,
  *Decidido en esta conversación* permite quitar o añadir decisiones (`PATCH
  /api/conversations/[id]` con `plan`) y llevar una a Memoria como **hecho sugerido**.
- **Enviar al Asistente** (`brief.ts`, `POST /api/advisor` con `brief: true`):
  - el modelo económico prepara el encargo a partir de la propuesta elegida, el plan y la
    conversación: qué ocurre, decisiones, restricciones, descartado, personajes, lugar; destino al
    final del capítulo por defecto. Las decisiones y lo descartado del plan van con las palabras del
    autor. Si su respuesta no sirve, el encargo se hace con la propuesta;
  - el autor lo revisa y edita (`SceneBriefEditor`); *Llevar al Asistente* rellena «Escribir escena»
    (argumento, personajes, lugar, destino) y muestra «Del Consejero» (se puede quitar);
  - la escena lleva el encargo en `<encargo_del_consejero>`, con la autoridad del argumento: cumplir
    decisiones y restricciones, que no ocurra lo descartado. Validado en el servidor (`parseBrief`);
  - nada se escribe: el Asistente prepara la propuesta, el autor la lee y la aplica (con la copia
    previa y *Deshacer* de siempre).
- **Interfaz:** selector *Conversar | Analizar* (recordado por novela); en Conversar, turnos de chat
  con propuestas compactas (sin tipo, confianza ni listas; una cita verificada como una línea con
  *Ir*), accesos rápidos *¿Cómo continúo?* · *Dame opciones* · *Necesito un giro* · *¿Qué pasa si…?*,
  y sin opciones técnicas. En el teléfono, lo mismo dentro de la hoja.
- **API:** sin `mode`, el Consejero responde en Analizar, como antes; el panel envía `conversar`.

## Argumento general · Fase 1: cuatro capas, el plan del autor y los tokens (sin cambios de base de datos)

- **Cuatro capas que no se confunden** (instrucciones de Analizar y Conversar): *canon* (el
  manuscrito y la Memoria aprobada), *estado actual* (fichas, lo que cada personaje sabe hasta aquí,
  cronología), *plan del autor* (sinopsis y notas: intención, no canon; nunca presentarlo como ya
  ocurrido ni adelantar sus revelaciones) e *ideas* (la conversación).
- **El plan del autor, una vez y sin IA** (`plan-text.ts`):
  - *visión general*, en el marco que se cachea: el plan entero si cabe (≈2.000 tokens); si no, su
    primer párrafo (la premisa), los títulos, la primera frase de cada párrafo y el último (el
    desenlace). Es la misma en cada turno;
  - *detalles*, en la petición: los párrafos completos que nombran a los personajes y lugares en
    juego o comparten palabras con la pregunta (≈1.500 tokens en Conversar, ≈2.500 en Analizar);
  - la sinopsis ya no va dos veces (antes en la Guía y en «Plan del autor») y las notas tampoco.
- **«Lo que saben hasta aquí»**: las revelaciones de las fichas a los personajes elegidos, hasta el
  capítulo actual (las últimas 15).
- **Un marco estable**: el mapa usa los capítulos guardados y las palabras redondeadas a cientos, así
  que escribir entre turnos no invalida la caché.
- **Conversar ligero**: las propuestas anteriores van más resumidas (25 como máximo, el texto de las
  5 últimas) y la que está en la mesa, siempre entera.

### Medición (`tests/e2e/tokens.test.mjs`)

Una novela de 30 capítulos (≈2.500 palabras cada uno) con fichas, sinopsis de 18.000 caracteres,
notas de 6.000 y 8 personajes; 8 turnos de Conversar (con escritura entre turnos), 2 de Analizar y
una escena del Asistente. Tokens de entrada estimados (caracteres / 3,5):

| | antes (main) | ahora |
|---|---|---|
| Conversar, por turno (instrucciones + marco + petición) | ≈17.000 | ≈13.700 |
| … de ellos, el prefijo cacheable | ≈9.400 | ≈4.600 |
| … turnos que reutilizan la caché | 5 de 8 | 7 de 8 |
| … coste efectivo con caché de Anthropic, por turno | ≈12.600 | ≈10.200 |
| Analizar, por turno | ≈19.500–22.300 | ≈17.200–19.900 |
| Escena del Asistente | ≈12.500 | ≈7.900 (sin el plan) |

Coste efectivo: la petición a precio normal, el prefijo a 1,25× cuando se escribe en caché y a 0,1×
cuando se reutiliza. La salida no cambia (tope de 3.000 tokens en Conversar, 4.000–6.000 en
Analizar). Ninguna llamada de IA nueva: la visión general, los detalles y la continuidad se calculan
sin IA.

## Argumento general · Fase 2: su propia sección (`novels.plot`)

- **Dónde:** *Argumento general*, en la lista de capítulos, abre la ventana de la novela en su pestaña
  (también se llega desde *Novela*). Un texto largo (hasta 100.000 caracteres) para toda la trama,
  los secretos y el desenlace previsto. Si está vacío y hay sinopsis, *Empezar desde la sinopsis* la
  copia para desarrollarla (la sinopsis no cambia).
- **Quién lo lee:** solo el Consejero, como parte del *plan del autor*, con el mayor peso (argumento
  6, sinopsis 3, notas 1). La visión general sube a ≈3.000 tokens cuando hay argumento (va en el
  marco cacheado: después del primer turno cuesta una décima parte) y los pasajes pertinentes a
  ≈2.000 en Conversar y ≈3.500 en Analizar, cada uno con su título («Argumento general:»). Un
  argumento de 100.000 caracteres nunca va entero.
- **El Asistente nunca lo recibe** (no está en la Guía Maestra ni en «Ver contexto»); probado en
  escenas, reescrituras y análisis.
- **Se copia** al duplicar la novela (desde la app, sin cambiar `duplicate_novel`) y va en la copia de
  seguridad (`procesador.json`).
- **Base de datos:** `supabase/actualizar-argumento.sql`, una sola instrucción aditiva e idempotente
  (`alter table public.novels add column if not exists plot text not null default ''`); también en
  `schema.sql` y `verificar.sql`. Las pruebas de esquema la ejecutan dos veces sobre bases antiguas.
