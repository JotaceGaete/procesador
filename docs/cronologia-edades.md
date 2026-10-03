# Cronología · Tratamiento de edades

> Estado: **diseño, sin implementar** (Prioridad 3, junto con el resto de la Cronología).
> Depende de que cada capítulo tenga un punto en el tiempo del relato, que es la base de la Cronología.

## Problema

`characters.age` es texto libre ("21 años", "nació en 1951", "unos cuarenta"). Sirve como nota, pero:

- no evoluciona: si el relato avanza cinco años, la ficha sigue diciendo "21 años" y el asistente la recibe así;
- no se puede comparar con nada, así que la app no puede avisar de que un personaje tiene 30 en el capítulo 4 y 28 en el 9;
- corregirlo a mano ("26 años") borra el dato de partida.

## Principios

1. **La edad no se guarda, se calcula.** Se guarda un *ancla* (nacimiento o edad en un punto conocido) y la edad en cada capítulo sale de la diferencia de tiempo.
2. **Nada se sobrescribe.** El texto actual de "Edad o nacimiento" se conserva como nota. El ancla es un dato aparte.
3. **La imprecisión es legítima.** "Nació en 1951" no dice si en 1972 tiene 20 o 21. La app muestra un rango ("20–21") en vez de inventar.
4. **Avisar, no corregir.** Las inconsistencias se señalan, y el autor decide. Un salto atrás o una edad "rara" pueden ser intencionados.
5. **Determinista, sin IA.** El cálculo y la detección son aritmética local, sin llamadas a ningún modelo.

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

### Punto temporal de cada capítulo (base de la Cronología)

```ts
// en chapters
story_start: StoryDate | null;   // cuándo empieza el capítulo en el tiempo del relato
story_end:   StoryDate | null;   // opcional; si falta, se asume el mismo punto
story_flashback: boolean;        // el capítulo ocurre antes que el anterior, a propósito
```

Un capítulo sin fecha **hereda** la del capítulo fechado anterior y se marca como *estimado* en la interfaz. Así basta con fechar los capítulos donde el tiempo salta.

### Ancla de edad del personaje

```ts
type AgeAnchor =
  | { kind: "birth"; date: StoryDate }                              // nació en 1951 (o 12/03/1951)
  | { kind: "age_at"; age: number; at: { chapter_id: string } | { date: StoryDate } }; // tenía 21 en el capítulo 1
```

```ts
// en characters (además de `age`, que se queda como nota libre)
age_anchor: AgeAnchor | null;
age_approx: boolean;             // "unos cuarenta": la edad es aproximada, se muestra con "≈" y no genera conflictos de ±1 año
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
alter table public.chapters
  add column if not exists story_start     jsonb,
  add column if not exists story_end       jsonb,
  add column if not exists story_flashback boolean not null default false;

alter table public.characters
  add column if not exists age_anchor jsonb,
  add column if not exists age_approx boolean not null default false,
  add column if not exists death      jsonb;

alter table public.facts
  add column if not exists story_date jsonb,
  add column if not exists age_claim  jsonb;
```

`jsonb` con validación en `lib/memory.ts`, igual que el resto de campos. `age_claim.character_id` y `age_at.at.chapter_id` se validan contra la misma novela en la API, porque no son claves foráneas. `duplicate_novel` debe reasignar esos ids, igual que hoy reasigna capítulos y personajes.

## Cálculo

`lib/chronology.ts`, puro y sin E/S:

```ts
storyPointOf(chapterId): { date: StoryDate | null; offset: Interval | null; estimated: boolean }
ageAt(character, point): { min: number; max: number; approx: boolean } | null
```

- Con fechas parciales se trabaja con intervalos. Nacido en 1951 → en 1972 tiene `{min: 20, max: 21}`. Nacido el 12/03/1951 y capítulo en 06/1972 → `{21, 21}`.
- Con `age_at` sobre un capítulo, la edad en otro capítulo es `age + Δ`, donde Δ es el tiempo entre ambos puntos (también un intervalo si las fechas son parciales).
- Sin ancla, o sin forma de relacionar los dos puntos, devuelve `null` y la interfaz muestra la nota libre tal cual.

**Ejemplo del enunciado.** Ancla: 21 años en el capítulo 1 (1972). Capítulo 6: 1977. En el capítulo 6 se muestra **26**, y la ficha sigue diciendo "21 en el capítulo 1". Si el capítulo 1 fuera "Año 0" y el 6 "Año 5", el resultado es el mismo.

## Detección de inconsistencias

| Regla | Gravedad | Ejemplo |
|---|---|---|
| Una declaración de edad (`age_claim`) cae fuera del rango calculado | Conflicto | Ancla: 21 en 1972. Hecho de 1980 dice 35 (debería ser 29). |
| Un personaje aparece (por nombre o apodo, como ya detecta `context.ts`) o tiene hechos en un punto anterior a su nacimiento | Conflicto | Nace en 1960; aparece en el capítulo de 1955. |
| Aparece en un punto posterior a `death` en un capítulo que no es retrospectiva | Aviso | Muere en 1980; dialoga en el capítulo de 1984. |
| Dos anclas o declaraciones incompatibles entre sí | Conflicto | Nació en 1951, pero un hecho de 1972 dice 25. |
| Las fechas de capítulo retroceden sin `story_flashback` | Aviso | Cap. 7 en 1975, cap. 8 en 1973. |
| Edad implausible para una relación de parentesco (padre/madre con menos de ~12 años de diferencia, o hijo mayor que su progenitor) | Aviso | Juan "padre de" Pedro; Juan nace en 1950, Pedro en 1958. |
| Edad negativa o mayor de ~120 en algún capítulo donde aparece | Conflicto | Normalmente revela un año mal tecleado. |

- Con `age_approx` no se marcan desfases de ±1 año.
- Retrospectivas: los capítulos con `story_flashback` no disparan el aviso de retroceso, pero sí se comprueban las edades en su punto.
- **Fuera de alcance de esta fase:** leer el texto del manuscrito buscando "tenía 30 años" junto a un nombre. Es heurístico y daría falsos positivos. Mientras tanto, la acción *Consistencia* del asistente recibe las edades calculadas (ver abajo) y puede señalarlo ella.

## Interfaz

- **Ficha del personaje**: "Edad o nacimiento" pasa a tener dos partes:
  - un selector *Nacimiento / Edad en un punto / Sin definir* con los campos estructurados;
  - la nota libre de siempre, con el texto actual intacto.
  
  Debajo, en gris: "En este capítulo: 26 años" (o "20–21", o "≈ 40").
- **Lista de capítulos**: un campo "Tiempo del relato" por capítulo (fecha parcial y la casilla *Retrospectiva*). Los heredados se muestran en cursiva como estimados.
- **Vista Cronología**: una tabla de personajes por capítulos, con la edad en cada celda. Las celdas con conflicto se marcan, y al pie hay una lista de inconsistencias que enlazan al capítulo, la ficha o el hecho implicado.

## Asistente (contexto de IA)

- En las fichas que se envían, la edad se da **calculada para el capítulo actual**: `Edad en este punto: 26 (21 en el capítulo 1; han pasado 5 años)`. La nota libre se añade sólo si aporta algo distinto.
- Si hay un conflicto que afecta a un personaje de la selección, la acción *Consistencia* lo recibe como dato.
- Esto cambia `lib/ai/prompts.ts` (formato de la ficha) y `lib/ai/context.ts` (pasar el punto temporal del capítulo).

## Migración del texto existente

- No se toca `characters.age`.
- Al abrir una ficha con nota pero sin ancla, la app intenta leer patrones simples ("21 años", "nació en 1951", "n. 1951") y **propone** un ancla: "¿21 años en el capítulo 1?". Sólo se guarda si el autor confirma.
- Una ficha sin ancla funciona igual que hoy.

## Pruebas previstas

- Unitarias de `lib/chronology.ts`: fechas parciales y rangos, anclas `birth` y `age_at`, herencia de fechas entre capítulos, calendario relativo, retrospectivas, `age_approx`, cada regla de la tabla de inconsistencias. Incluye el caso del enunciado (21 → 26 en cinco años, sin cambiar el ancla).
- API: validación de `StoryDate` y de ids entre novelas, y `duplicate_novel` reasignando ids dentro del JSON.
- Prompts: la ficha enviada muestra la edad calculada para el capítulo actual.
- E2E: definir un ancla, fechar dos capítulos y ver la edad cambiar al pasar de uno a otro. Una declaración contradictoria aparece en la lista de inconsistencias.

## Orden de implementación sugerido

1. Fecha del relato por capítulo (base de toda la Cronología).
2. Ancla de edad, cálculo y "En este capítulo: N años" en la ficha.
3. Edad calculada en el contexto del asistente.
4. Vista Cronología y reglas de inconsistencia.
5. Declaraciones de edad en hechos y propuesta de ancla desde la nota libre.
