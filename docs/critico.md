# Crítico Literario

> Estado: **fase 1 implementada** (núcleo). Diseño aprobado por el autor el 9 de octubre de 2026, con
> sus seis recomendaciones y tres ajustes: notas con un decimal, una conclusión explícita sobre la
> experiencia del lector y contradicciones contrastadas con el manuscrito. Fases 2 (calibración con
> un modelo real) y 3 (panorama de la novela) pendientes.

## Qué es, y qué no es

|  | Asistente | Consejero | Crítico |
|---|---|---|---|
| Papel | Escribe contigo | Piensa contigo | Te juzga como lector exigente |
| Salida | Texto aplicable | Observaciones, caminos, revisión de escena | Notas, experiencia del lector y veredicto |
| Unidad | Selección o escena | Selección, capítulo o novela | Un capítulo terminado |
| Toca el manuscrito | Sólo si el autor aplica | Nunca | Nunca |

**Principios:**

- **Juicio, no corrección.** No propone texto alternativo ni listas de arreglos. El informe no tiene
  *Aplicar*, *Reescribir* ni *Enviar al Asistente*.
- **Independencia.** No lee las conversaciones ni las observaciones del Consejero, ni sus propios
  informes anteriores, ni la respuesta del autor a ellos.
- **Sin complacencia.** Escala anclada, citas obligatorias; puede decir «excelente» y «mediocre» o
  «aburrido».
- **Pausado no es aburrido.** Declara el tipo de capítulo antes de calificar el ritmo.
- **Ficción adulta por su oficio** (`ADVISOR_ADULT_FICTION`, más una línea propia: el sexo, la violencia
  o la ambigüedad moral no bajan ni suben ninguna nota).
- **El autor decide.** El informe es una opinión con fecha, modelo y versión del capítulo.

## Funcionamiento

El autor pulsa **Crítico** en la barra superior y, en la vista, *Evaluar capítulo*. Se guarda el
capítulo abierto y el Crítico lo lee **tal como quedó guardado**, en una sola llamada al modelo
(`role: "critic"`). Nunca se lanza solo.

**Qué lee** (`buildCriticRequest`, `src/lib/critic/evaluate.ts`):

- el capítulo completo, con las imágenes descritas;
- la Guía Maestra (qué novela quiere ser: género, tono, narrador);
- el resumen global y las fichas de los capítulos anteriores, con sus citas ancla que **siguen en el
  texto** (pasajes literales del manuscrito). Las fichas desactualizadas van marcadas; los capítulos
  sin ficha se nombran como desconocidos. No genera fichas: usa las que haya;
- los últimos 2.500 caracteres del capítulo anterior, literales;
- los cabos abiertos y las fichas de Memoria de los personajes que aparecen (hasta 8, recortadas).

**Qué no lee:** la sinopsis, las notas ni el Argumento general (el plan del autor y sus secretos:
el Crítico lee como un lector que ha llegado hasta aquí), los capítulos posteriores, nada del
Consejero ni informes anteriores.

**Criterios** (`src/lib/critic/criteria.ts`): Interés, Emoción, Tensión narrativa, Diálogos, Ritmo,
Atmósfera, Deseo de continuar, Prosa y estilo, Función en la novela. Nota de 1 a 10 **con un
decimal**; sólo Diálogos puede ser «no aplica».

**Orden de la respuesta** (JSON): tipo de capítulo; experiencia del lector (tramos con su efecto
y cita, efectos de conjunto —entretiene, emociona, aburre, pierde interés— y una conclusión
explícita); notas con justificación y citas; nota global (juicio, no media; la media se muestra al
lado); lo mejor y lo más débil; contradicciones; veredicto (*Excelente*, *Sólido*, *Irregular*,
*No funciona todavía*) y su párrafo.

## Validación (`src/lib/critic/schema.ts`)

El servidor valida todo antes de guardar, con el mecanismo de `completeJson`: si la primera
respuesta no cumple, se le devuelve al modelo una vez con el motivo; la segunda se acepta y lo que
siga fallando queda **marcado, nunca escondido**.

- Notas fuera de 1–10, criterios que faltan, veredicto o efectos fuera del conjunto: rechazo.
- Cada nota necesita al menos una cita; cada cita se busca en el capítulo (`findQuote`). Una nota
  sin ninguna cita encontrada se muestra como **impresión**.
- **Sin reescritura:** una «cita» de más de 300 caracteres se devuelve («las citas deben ser
  breves, nunca un fragmento reescrito»); todos los campos tienen longitud máxima.
- Los tramos se ordenan por su lugar en el capítulo.

### Contradicciones contrastadas con el manuscrito (ajuste 3)

- Las instrucciones dicen que el manuscrito manda y que una contradicción sólo cuenta si se pueden
  citar literalmente **los dos pasajes del manuscrito**.
- El servidor busca la cita del capítulo evaluado y la del pasaje anterior en el capítulo que se
  nombra y, si no está ahí, en cualquier capítulo hasta el evaluado (corrige el número).
- Si alguna no aparece, la contradicción queda **no confirmada**. Si además el Crítico dijo que bajó
  una nota (`affects`), la respuesta se le devuelve: «el manuscrito manda: deja "affects" vacío y
  califica sin tenerlas en cuenta». Si insiste, se guarda y el informe lo dice: «no debe pesar en la
  evaluación… El Crítico dijo que afectó a: …».

## Interfaz (`src/components/CriticReport.tsx`)

Una vista propia (modal ancho; pantalla completa en el móvil, con la tabla convertida en lista):

- veredicto, nota global y media; fecha, proveedor y modelo; si el capítulo cambió desde entonces
  («con retoques» o «versión anterior», con la huella de `freshness.ts`);
- experiencia del lector, tabla de calificaciones, lo mejor y lo más débil, contradicciones;
- cada cita con **Ir**, que cierra la vista y selecciona el fragmento sin modificarlo; «sin cita
  verificable» o «ya no está en el texto» cuando no se puede;
- **tu respuesta**: *De acuerdo* / *En desacuerdo* y una nota personal. No cambia el informe y el
  Crítico no la lee. *Eliminar este informe*;
- *Volver a evaluar* (otra fila; el informe anterior queda en el **Historial**) y el proveedor;
- «Leyó: …», tokens y coste estimado.

Por encima de `AI_CONFIRM_TOKENS` pide confirmación antes de enviar nada.

## API

| Ruta | Qué hace |
|---|---|
| `GET /api/chapters/{id}/critiques` | Informes del capítulo, del más reciente al más antiguo, con su vigencia y dónde está cada cita ahora |
| `POST /api/chapters/{id}/critiques` | `{ provider, approvedTokens? }` → `{ done: true, critique }` o `{ done: false, confirm }` |
| `PATCH /api/critiques/{id}` | `{ response: "agree" \| "disagree" \| null, note }`. Nada más: ni notas ni veredicto |
| `DELETE /api/critiques/{id}` | Borra un informe |

## Modelo y coste

`{PROVEEDOR}_MODEL_CRITIC`; si no existe, el del Consejero (`_MODEL_ADVISE`), y si tampoco, el de
escritura. Cada evaluación queda en `ai_usage` con `purpose = 'critic'`. Salida máxima: 5.000
tokens. Un capítulo de 4.000 palabras con su contexto ronda los 12.000–15.000 tokens de entrada.

## Base de datos

Tabla `chapter_critiques` (`supabase/schema.sql`; para una base existente,
`supabase/actualizar-critico.sql`, idempotente): un informe por evaluación, con `source_revision` y
`text_sketch`, aislada por novela, RLS y sin acceso público. Sólo guarda citas breves del
manuscrito. Se borra con el capítulo (también al mandarlo a la papelera: al restaurarlo, vuelve sin
informes) y con la novela; no se copia al duplicar. `ai_usage` admite el propósito `critic`.

## Pruebas

- `tests/unit/critic.test.ts`: escala y decimales, criterios, «no aplica», citas e impresiones,
  citas largas, experiencia del lector, veredictos, contradicciones confirmadas y no confirmadas,
  instrucciones (no reescribe, sin complacencia, pausado, ficción adulta, el manuscrito manda),
  qué lleva la petición y el modelo.
- `tests/e2e/critic.test.mjs`, con el modelo simulado: el informe completo, qué lee y qué no (ni
  sinopsis, ni Argumento general, ni informes anteriores, ni la nota del autor), un capítulo
  mediocre, reintentos, las tres clases de contradicción, historial y vigencia, la respuesta del
  autor, límites y confirmación, duplicado y borrado, y la vista con *Ir*. El manuscrito no cambia.
- `tests/schema/run.mjs`: `actualizar-critico.sql` dos veces sobre una base anterior, sin tocar datos.

Son pruebas deterministas: comprueban qué recibe el modelo y qué hace Procesador con su respuesta,
no la calidad del juicio de un modelo real. Eso es la fase 2.

## Fases

1. **Núcleo** (esta). Hecha.
2. **Calibración real.** `eval:critico` con seis capítulos de prueba ficticios (excelente, mediocre,
   contemplativo logrado, erótico bien y mal escrito, violento y ambiguo), tres pasadas cada uno; una
   diferencia de más de 1,5 puntos en la nota global entre pasadas indica inestabilidad. Necesita una
   clave de proveedor. Después, con capítulos reales del autor.
3. **Panorama.** Nota en el navegador de capítulos, curva de notas de la novela y comparación de dos
   evaluaciones lado a lado.
