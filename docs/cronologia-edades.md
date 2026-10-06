# Cronología · Tratamiento de edades

> Estado: **implementados los pasos 1 a 4** del orden sugerido (Fase 3 del plan profesional): marcas de tiempo por capítulo, ancla de edad y cálculo, edad en el contexto de la IA, vista Cronología con advertencias. Pendientes los pasos 5 y 6 (ver «Estado de la implementación», al final).
> La primera versión fecha cada capítulo; el modelo está preparado para admitir después cambios de tiempo dentro de un capítulo o escena sin rediseñarlo.

## Problema

`characters.age` es texto libre ("21 años", "nació en 1951", "unos cuarenta"). Sirve como nota, pero:

- no evoluciona: si el relato avanza cinco años, la ficha sigue diciendo "21 años" y el asistente la recibe así;
- no se puede comparar con nada, así que la app no puede avisar de que un personaje tiene 30 en el capítulo 4 y 28 en el 9;
- corregirlo a mano ("26 años") borra el dato de partida.

## Principios

1. **La edad no se guarda, se calcula.** Se guarda un *ancla* (nacimiento o edad en un punto conocido) y la edad en cada capítulo sale de la diferencia de tiempo.
2. **Nada se sobrescribe.** El texto actual de "Edad o nacimiento" se conserva como nota. El ancla es un dato aparte.
3. **La imprecisión es legítima.** "Nació en 1951" no dice si en 1972 tiene 20 o 21. La app muestra un rango ("20–21") en vez de inventar.
4. **Advertir, nunca bloquear.** Las inconsistencias temporales son advertencias para el autor, no errores. Nada impide guardar, escribir, insertar una escena ni usar el asistente. Un salto atrás o una edad "rara" pueden ser intencionados, y el autor puede descartar una advertencia concreta.
5. **Determinista, sin IA.** El cálculo y la detección son aritmética local, sin llamadas a ningún modelo.
6. **Del capítulo a la escena sin rediseño.** El tiempo del relato se modela como marcas temporales ancladas a una posición del manuscrito. En la primera versión la única posición admitida es el inicio del capítulo; más adelante, cualquier punto del texto.

## Modelo de datos

### Fecha del relato

Una fecha parcial, para que el autor dé sólo la precisión que conoce:

```ts
interface StoryDate {
  year: number;      // 1972, o año relativo (0, 5…) si la novela no tiene calendario real
  month?: number;    // 1–12
  day?: number;      // 1–31
}
```

Ajuste de novela (Guía Maestra o Cronología): `calendar: "real" | "relativo"`. En calendario relativo los años se muestran como "Año 0", "Año 5", y el autor no está obligado a inventar fechas reales.

### Marcas temporales (base de la Cronología)

El tiempo del relato no es una columna del capítulo. Es una lista de **marcas temporales**, cada una anclada a un punto del manuscrito:

```ts
interface TimeMark {
  id: string;
  chapter_id: string;
  anchor: { at: "chapter_start" }                          // v1: sólo esto
        | { at: "text"; offset: number; quote: string };   // futuro: dentro del capítulo o escena
  when: { date: StoryDate }                                 // "marzo de 1972"
      | { after: Interval; from?: string /* id de otra marca; por defecto, la anterior */ };  // "cinco años después"
  flashback: boolean;   // a propósito anterior a la marca previa
  label: string;        // texto libre opcional: "cinco años después", "esa misma noche"
}

interface Interval { years?: number; months?: number; days?: number }
```

- **Primera versión:** cada capítulo tiene como mucho una marca, con `anchor.at = "chapter_start"`. En la interfaz es el campo "Tiempo del relato" del capítulo, sin hablar de marcas.
- **Fechas relativas desde el principio.** `when.after` ya permite "cinco años después del capítulo anterior" sin fecha absoluta. Es el mismo mecanismo que necesitará "cinco años después" en mitad de un capítulo.
- **Herencia.** Un punto del texto sin marca propia toma la marca anterior en orden de lectura (capítulo y posición), marcado como *estimado*. En la v1 eso equivale a heredar la del capítulo anterior.

**Evolución sin rediseño.** Para admitir saltos dentro de un capítulo o escena basta con:

1. Permitir `anchor.at = "text"` y más de una marca por capítulo. Ni la tabla ni el cálculo cambian, porque ya resuelven "la marca vigente en una posición".
2. Crear marcas desde el editor: seleccionar "Cinco años después" y elegir *Marcar cambio de tiempo aquí*.
3. Mantener los anclajes cuando el texto cambia. `offset` se recoloca con `quote` (el texto citado), con la misma técnica que `applyRewrite` ya usa para encontrar un fragmento que se movió. Si la cita desaparece, la marca pasa al inicio del capítulo con una advertencia, sin perderse.

Todo lo que consume tiempo (edades, contexto de IA, advertencias) pregunta por **una posición** (`chapter_id` y `offset`), nunca por "el capítulo". En la v1 el offset se ignora; cuando existan marcas internas, las mismas funciones darán la edad correcta antes y después del salto.

### Ancla de edad del personaje

```ts
type AgeAnchor =
  | { kind: "birth"; date: StoryDate }                              // nació en 1951 (o 12/03/1951)
  | { kind: "age_at"; age: number; at: { mark_id: string } | { date: StoryDate } }; // tenía 21 en el capítulo 1 (su marca)
```

```ts
// en characters (además de `age`, que se queda como nota libre)
age_anchor: AgeAnchor | null;
age_approx: boolean;             // "unos cuarenta": la edad es aproximada, se muestra con "≈" y no genera advertencias por ±1 año
death: StoryDate | null;         // opcional; para avisar de apariciones posteriores
```

- `age_at` con capítulo es lo más natural para el caso descrito: "tenía 21 en el capítulo 1". Si el capítulo 1 todavía no tiene fecha, el ancla sigue siendo válida en términos relativos: la edad en otro capítulo es 21 + (tiempo transcurrido entre ambos), aunque ninguno tenga año absoluto.
- `age_at` se convierte internamente en un rango de nacimiento: tener 21 en 1972 significa nacer entre 1950 y 1951.

### Declaraciones de edad (para contrastar)

Un hecho de continuidad puede afirmar una edad:

```ts
// en facts (opcional)
story_date: StoryDate | null;     // versión estructurada de story_time, que sigue como texto libre
age_claim: { character_id: string; age: number } | null;   // "en este hecho, Elena tiene 30"
```

Así una afirmación del manuscrito ("cumplió treinta ese invierno") queda registrada y la Cronología la comprueba contra el ancla.

### Esquema (borrador)

```sql
create table if not exists public.time_marks (
  id          uuid primary key default gen_random_uuid(),
  novel_id    uuid not null references public.novels(id) on delete cascade,
  chapter_id  uuid not null,
  anchor      jsonb not null default '{"at":"chapter_start"}',
  "when"      jsonb not null,
  flashback   boolean not null default false,
  label       text not null default '',
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);
-- v1: una marca por capítulo, sólo al inicio. Se elimina este índice al admitir marcas internas.
create unique index if not exists time_marks_one_per_chapter
  on public.time_marks(chapter_id) where (anchor ->> 'at') = 'chapter_start';

alter table public.characters
  add column if not exists age_anchor jsonb,
  add column if not exists age_approx boolean not null default false,
  add column if not exists death      jsonb;

alter table public.facts
  add column if not exists story_date jsonb,
  add column if not exists age_claim  jsonb;
```

`jsonb` con validación en `lib/memory.ts`, igual que el resto de campos. `age_claim.character_id` y `age_at.at.mark_id` se validan contra la misma novela en la API, porque no son claves foráneas. `duplicate_novel` debe reasignar esos ids, igual que hoy reasigna capítulos y personajes, y copiar también `time_marks`.

## Cálculo

`lib/chronology.ts`, puro y sin E/S:

```ts
type Position = { chapter_id: string; offset?: number };   // offset se ignora en la v1
type StoryPoint = Position | { mark_id: string } | { date: StoryDate };
storyPointAt(pos: Position): { date: StoryDate | null; sinceMark: Interval | null; estimated: boolean }
ageAt(character, at: StoryPoint): { min: number; max: number; approx: boolean } | null
warnings(novel): TimeWarning[]
```

- Con fechas parciales se trabaja con intervalos. Nacido en 1951 → en 1972 tiene `{min: 20, max: 21}`. Nacido el 12/03/1951 y capítulo en 06/1972 → `{21, 21}`.
- Con `age_at` sobre una marca, la edad en otro capítulo es `age + Δ`, donde Δ es el tiempo entre ambos puntos (también un intervalo si las fechas son parciales).
- Sin ancla, o sin forma de relacionar los dos puntos, devuelve `null` y la interfaz muestra la nota libre tal cual.

**Ejemplo del enunciado.** Ancla: 21 años en el capítulo 1 (1972). Capítulo 6: 1977. En el capítulo 6 se muestra **26**, y la ficha sigue diciendo "21 en el capítulo 1". Si el capítulo 1 fuera "Año 0" y el 6 "Año 5", o si el 6 dijera sólo "cinco años después", el resultado es el mismo. Cuando existan marcas internas, un "cinco años después" a mitad del capítulo 6 hará que el personaje tenga 21 antes de la marca y 26 después.

`StoryPoint` es el mismo tipo que usan el ancla `age_at.at` y la asociación temporal de las imágenes de personaje (`character_images.story_at`, ver [Memoria visual](personajes-galeria.md)). Una imagen de "Erika, 1982" guarda la fecha, no la edad, y su edad se calcula con `ageAt(erika, { date: { year: 1982 } })`.

## Advertencias temporales

Todas son **advertencias para el autor, nunca errores bloqueantes**. No impiden guardar, escribir, insertar ni consultar al asistente, y la API las calcula aparte, sin rechazar ningún dato por incoherente. Hay dos niveles, sólo para ordenar la lista:

- **Probable error**: casi seguro un descuido (edad negativa, contradicción entre dos datos).
- **Revisar**: puede ser intencionado (retroceso, aparición tras la muerte).

El autor puede **descartar** una advertencia concreta ("es intencionado"). El descarte se guarda y no vuelve a aparecer mientras no cambien los datos que la producen.

| Regla | Nivel | Ejemplo |
|---|---|---|
| Una declaración de edad (`age_claim`) cae fuera del rango calculado | Probable error | Ancla: 21 en 1972. Hecho de 1980 dice 35 (debería ser 29). |
| Un personaje aparece (por nombre o apodo, como ya detecta `context.ts`) o tiene hechos en un punto anterior a su nacimiento | Probable error | Nace en 1960; aparece en el capítulo de 1955. |
| Aparece en un punto posterior a `death` en un capítulo que no es retrospectiva | Revisar | Muere en 1980; dialoga en el capítulo de 1984. |
| Dos anclas o declaraciones incompatibles entre sí | Probable error | Nació en 1951, pero un hecho de 1972 dice 25. |
| Las fechas retroceden respecto a la marca anterior sin `flashback` | Revisar | Cap. 7 en 1975, cap. 8 en 1973. |
| Edad implausible para una relación de parentesco (padre/madre con menos de ~12 años de diferencia, o hijo mayor que su progenitor) | Revisar | Juan "padre de" Pedro; Juan nace en 1950, Pedro en 1958. |
| Edad negativa o mayor de ~120 en algún capítulo donde aparece | Probable error | Normalmente revela un año mal tecleado. |

- Con `age_approx` no se marcan desfases de ±1 año.
- Retrospectivas: las marcas con `flashback` no disparan el aviso de retroceso, pero sí se comprueban las edades en su punto.
- **Fuera de alcance de esta fase:** leer el texto del manuscrito buscando "tenía 30 años" junto a un nombre. Es heurístico y daría falsos positivos. Mientras tanto, la acción *Consistencia* del asistente recibe las edades calculadas (ver abajo) y puede señalarlo ella.

## Interfaz

- **Ficha del personaje**: "Edad o nacimiento" pasa a tener dos partes:
  - un selector *Nacimiento / Edad en un punto / Sin definir* con los campos estructurados;
  - la nota libre de siempre, con el texto actual intacto.
  
  Debajo, en gris: "En este capítulo: 26 años" (o "20–21", o "≈ 40").
- **Lista de capítulos**: un campo "Tiempo del relato" por capítulo: fecha parcial **o** "N años/meses/días después", y la casilla *Retrospectiva*. Por debajo crea o edita la marca de inicio del capítulo. Los heredados se muestran en cursiva como estimados.
- **Advertencias**: un indicador discreto (por ejemplo "2 advertencias de tiempo") en la ficha y en la Cronología. Nunca un diálogo modal ni un botón deshabilitado.
- **Vista Cronología**: una tabla de personajes por capítulos, con la edad en cada celda. Las celdas con advertencia se marcan, y al pie hay una lista de advertencias que enlazan al capítulo, la ficha o el hecho implicado.

## Asistente (contexto de IA)

- En las fichas que se envían, la edad se da **calculada para el capítulo actual**: `Edad en este punto: 26 (21 en el capítulo 1; han pasado 5 años)`. La nota libre se añade sólo si aporta algo distinto.
- Si hay una advertencia que afecta a un personaje de la selección, la acción *Consistencia* lo recibe como dato.
- Esto cambia `lib/ai/prompts.ts` (formato de la ficha) y `lib/ai/context.ts` (pasar el punto temporal del capítulo).

## Migración del texto existente

- No se toca `characters.age`.
- Al abrir una ficha con nota pero sin ancla, la app intenta leer patrones simples ("21 años", "nació en 1951", "n. 1951") y **propone** un ancla: "¿21 años en el capítulo 1?". Sólo se guarda si el autor confirma.
- Una ficha sin ancla funciona igual que hoy.

## Pruebas previstas

- Unitarias de `lib/chronology.ts`: fechas parciales y rangos, anclas `birth` y `age_at`, marcas relativas ("cinco años después"), herencia de marcas, varias marcas en un mismo capítulo (aunque la v1 no las cree, el cálculo ya debe resolverlas), calendario relativo, retrospectivas, `age_approx`, cada regla de la tabla de inconsistencias. Incluye el caso del enunciado (21 → 26 en cinco años, sin cambiar el ancla).
- API: validación de `StoryDate` y de ids entre novelas, y `duplicate_novel` reasignando ids dentro del JSON.
- Prompts: la ficha enviada muestra la edad calculada para el capítulo actual.
- E2E: definir un ancla, fechar dos capítulos y ver la edad cambiar al pasar de uno a otro. Una declaración contradictoria aparece como advertencia, y el capítulo se sigue guardando y editando con normalidad.

## Orden de implementación sugerido

1. Marcas temporales con una por capítulo (base de toda la Cronología).
2. Ancla de edad, cálculo y "En este capítulo: N años" en la ficha.
3. Edad calculada en el contexto del asistente.
4. Vista Cronología y advertencias.
5. Declaraciones de edad en hechos y propuesta de ancla desde la nota libre.
6. (Posterior) Marcas dentro del capítulo o escena: quitar el índice de una marca por capítulo y añadir *Marcar cambio de tiempo aquí* en el editor.

## Estado de la implementación

**Hecho (pasos 1 a 4):**

- **Esquema** (`supabase/schema.sql`): tabla `time_marks` (una marca de inicio por capítulo, con índice único; `anchor` ya preparado para marcas internas), `novels.calendar` (`real` | `relative`) y `novels.dismissed_warnings`, `characters.age_anchor`, `age_approx` y `death`. `duplicate_novel` copia las marcas y reasigna el capítulo de un ancla «edad en un capítulo». Validación en la API con `src/lib/chronology.ts` (`parseStoryDate`, `parseWhen`, `parseAgeAnchor`); el capítulo de un ancla debe ser de la misma novela.
- **Cálculo** (`src/lib/chronology.ts`, puro): fechas parciales como rangos de días, calendario real o relativo, marcas «N años/meses/días después», herencia (estimada) y un «inicio de la historia» cuando aún no hay fechas. `ageAt` (rangos) y `ageOf` (ancla en un capítulo).
- **El tiempo como lo escribe el autor.** Con un ancla «21 en el capítulo 1» y fechas de la misma precisión, la diferencia se lee como la escribe el autor: de «1972» a «1977» son cinco años, y la edad es **26**, no el rango 25–27 que darían los extremos de ambos años. Si el tiempo transcurrido no es un número entero de años (cinco años y medio), la edad es un rango (26–27). Con precisiones distintas («1972» y «marzo de 1977») o sin forma de relacionarlas, se usan los rangos de las fechas, sin inventar.
- **Interfaz:** en la ficha del personaje, «Edad en el tiempo del relato» (sin definir, nacimiento, edad en un capítulo, edad en una fecha; aproximada; muerte opcional) con «En este capítulo: N años». El ancla sólo existe cuando sus datos están completos: no se inventa un año por defecto. En la lista de capítulos, **Cronología**: calendario, el tiempo de cada capítulo (fecha, tiempo después del anterior, o heredado, en cursiva), retrospectiva y nota, la tabla de edades por capítulo y las advertencias con «Es intencionado» y «Volver a avisar». La tabla se desplaza dentro de la ventana en el teléfono.
- **Advertencias** (nunca bloquean nada): retroceso sin retrospectiva, aparece antes de nacer, más de 120 años, aparece después de morir fuera de una retrospectiva, padre o madre con menos de 12 años de diferencia o más joven que su hijo. «Aparece» = nombrado (nombre, primer nombre o alias) en el texto del capítulo. Una advertencia descartada vuelve si cambian los datos que la producen.
- **IA:** la ficha enviada lleva «Edad en este punto de la historia: 26 años (21 en el capítulo 1)» en lugar de la nota libre, y la petición lleva «Tiempo del relato: …» del capítulo (sólo de marcas hasta ese capítulo). *Consistencia* y *Personaje* reciben las advertencias de cronología de los personajes implicados. Todo visible en «Ver contexto». La fecha de muerte nunca se envía a la IA.

**Pendiente:**

- Paso 5: edades declaradas en hechos (`facts.story_date`, `age_claim`) y la propuesta de ancla a partir de la nota libre.
- Paso 6: marcas dentro de un capítulo o escena.
- Edad de las imágenes de personaje (`character_images.story_at`).
- Una marca se borra con su capítulo; recuperar el capítulo de la papelera no la recupera.
- Las fichas de personaje y las relaciones siguen siendo atemporales para la IA (ver [deuda](deuda.md)).

