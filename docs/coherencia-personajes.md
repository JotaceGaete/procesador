# Coherencia de personajes: fichas, manuscrito y Cronología

**Estado: diseño aprobado conceptualmente. No implementado.** No hay cambios en la base de
datos ni en el código. Se retomará después de terminar el Argumento general.

## El problema (auditoría)

La Memoria se usa, pero solo como texto que lee la IA:

- `formatCharacter` (`src/lib/ai/prompts.ts`) envía la ficha entera; `relevantCharacters` y
  `selectMemory` (`src/lib/ai/context.ts`) eligen a quién. Llega a las escenas del Asistente,
  a sus acciones *Revisar consistencia*, *Coherencia del personaje*, *Mejorar diálogo* y
  *Evolución* (`EDIT_TASKS`), y al Consejero (`memoryBlock`, acciones *coherencia* y *personajes*).
- La lectura de capítulos (`src/lib/advisor/reading.ts`) recibe solo nombres y alias: no
  compara el texto con la ficha.
- La comprobación sin IA (`src/lib/continuity.ts`) revisa nombres, ropa, lugar y edad, pero solo
  en las propuestas del Asistente, nunca en el manuscrito.
- La Cronología (`src/lib/chronology.ts`) calcula edades por capítulo (`birthRange`, `ageAt`) y
  avisa de imposibles (antes de nacer, más de 120 años, después de morir, padres e hijos), pero
  no compara lo que dice el texto («Claudia, de 40 años») ni el campo libre «Edad o nacimiento».
- La descripción física es una sola, sin fecha: un cambio legítimo no se puede expresar.
- No existe un año presente de la novela. Un capítulo sin fecha hereda la del anterior, también
  después de una retrospectiva (`timeline`), y antes de la primera fecha cuenta en tiempo
  relativo, sin edades.

Consecuencia: «Claudia, delgada» en la Memoria y «obesidad mórbida» en el manuscrito no se
detecta salvo que el autor pida un análisis sobre ese pasaje y el modelo lo vea.

## Principios

1. **Informativo.** Ningún aviso cambia el manuscrito ni la Memoria por sí solo. Toda corrección
   la hace o la confirma el autor.
2. **Pocos falsos positivos antes que muchos avisos.** Ante la duda sobre a quién se refiere
   una expresión, no se avisa.
3. **El tiempo de la historia manda.** Cada comparación se hace con lo que era verdad en la fecha
   narrativa de ese pasaje, no en el presente ni en el orden de los capítulos.
4. **Primero sin IA**, y la IA solo reutilizando lecturas que ya se hacen: ninguna llamada nueva.
5. **Discreto.** Nada interrumpe la escritura.

## 1. Año presente por novela

- Columna `novels.present` (`jsonb`, una `StoryDate`, vacía por defecto). En la Cronología:
  «Presente de la novela: 2026». En nuestra novela, 2026; ninguna otra cambia.
- Un capítulo sin fecha propia toma el presente (en lugar del tiempo relativo «Año 0»), o la
  última fecha **no retrospectiva** anterior a él. Hoy hereda la de la retrospectiva: se corrige.
- Las fechas marcadas en capítulos mandan siempre sobre el presente.
- Sin código, hoy: marcar el capítulo 1 con 2026 en la Cronología hace que los siguientes lo
  hereden (estimado). Las retrospectivas deben marcarse, por la herencia descrita arriba.

## 2. Tres clases de información, nunca mezcladas

| Clase | Origen | Uso |
|---|---|---|
| **Establecido** | Lo escribe el autor en la ficha o en un rasgo, o un hecho aprobado de la Memoria | Referencia de las comparaciones |
| **Cambio aprobado** | Un rasgo con vigencia («desde 2019», «desde el cap. 14») que el autor crea o confirma | Sustituye al anterior desde su fecha |
| **Observación provisional** | Lo que la IA o un detector cree ver en el texto | Solo genera avisos o sugerencias; nunca se usa como referencia hasta que el autor la aprueba |

Las sugerencias de la IA (por ejemplo, rasgos extraídos de una descripción) llegan con origen
`sugerido` y no cuentan hasta que el autor las aprueba, como los hechos sugeridos de hoy.

## 3. Rasgos con vigencia por fecha narrativa

Tabla `character_traits`:

| Campo | Contenido |
|---|---|
| `character_id` | El personaje |
| `kind` | `complexion`, `estatura`, `cabello`, `ojos`, `piel`, `senas` (cicatriz, tatuaje), `otro` |
| `value` | «delgada», «canosa», «cicatriz en la ceja izquierda» |
| `valid_from` | Una **fecha narrativa** (`StoryDate`) o, si no la hay, un capítulo; vacía significa «siempre» |
| `valid_to` | Opcional, para rasgos temporales (una escayola, un embarazo) |
| `gradual` | El cambio es progresivo (peso, canas): solo se avisa ante saltos imposibles |
| `reason` | Opcional: «tras la depresión» |
| `status` | `approved` o `suggested` |

- **Vigencia por fecha.** El rasgo válido en un pasaje es el último con `valid_from` no
  posterior a la **fecha narrativa del pasaje** (de la Cronología, o del presente de la novela).
  Así, una retrospectiva a 2010 se compara con la apariencia de 2010, aunque esté en el
  capítulo 20. Si un rasgo solo tiene capítulo, se convierte en la fecha de ese capítulo; sin
  fechas en la novela, se usa el orden de los capítulos.
- **La descripción libre se conserva.** Para las fichas existentes, el modelo económico propone
  una sola vez los rasgos que encuentra en la descripción (con origen `sugerido`) y el autor los
  aprueba uno a uno.
- La edad no es un rasgo: sale del nacimiento o de la «edad en tal momento» de la Cronología.

## 4. Detección

### A. Sin IA, al guardar o salir de un capítulo (milisegundos, 0 tokens)

**Atribución: a quién describe la expresión.** No basta con el nombre y un adjetivo en la misma
frase. Se cuenta como descripción de un personaje solo cuando:

- la expresión depende del nombre: aposición («Claudia, delgada y nerviosa,»), predicado
  («Claudia era/estaba/parecía delgada»), complemento («la delgada Claudia»), o posesivo en
  la misma oración sin otro candidato («Claudia se miró: su cuerpo…»);
- y en la oración no hay otro personaje de la Memoria ni otro sustantivo de persona al que pueda
  referirse («su madre», «la mujer», «el hombre») entre el nombre y la expresión. Los posesivos y
  pronombres ambiguos («su», «ella») con dos candidatos posibles no avisan.

Se descartan además:

- recuerdos, sueños e hipótesis: «cuando tenía», «de niña», «años atrás», «recordó», «soñó»,
  «imaginó», «si fuera», «como si», «parecía que fuera»;
- comparaciones y figuras: «delgada como un junco» describe, pero «más gorda que su hermana» es
  relativa y no se compara con la ficha;
- el diálogo cuenta, pero con menos peso: un personaje puede mentir o exagerar. El aviso dice
  «dicho por un personaje».

**Rasgos físicos.** Vocabulario por tipo con una escala de incompatibilidad:

- complexión: delgada/flaca/menuda … robusta/corpulenta … obesa/obesidad mórbida;
- cabello: rubio, castaño, moreno, pelirrojo, canoso, calvo; largo, corto;
- ojos, piel y estatura con sus colores y grados.

«Delgada» frente a «obesidad mórbida» es una contradicción; frente a «robusta», solo un «revisa».

**Edad escrita.** Se aplica al manuscrito el detector del Asistente («Claudia, de 40 años»,
«Claudia tenía cuarenta años») con su misma atribución, contra la edad calculada para la fecha
de ese pasaje. Además:

- «nació en 1985» frente al nacimiento de la ficha;
- el campo libre «Edad o nacimiento» frente al dato estructurado.

### B. Con la lectura de capítulos que ya se hace (sin llamada nueva)

La ficha de capítulo (`chapter_digests`) añade `traits`: rasgos observados, cada uno con
personaje, tipo, valor y una **cita literal verificada** (como las citas de hoy). Así se detecta
lo que no usa la palabra exacta («la silla crujió bajo su peso»). La comparación con la ficha
sigue siendo sin IA. La lectura **no recibe** los rasgos de la Memoria: lee el texto y nada más,
para no condicionarla.

Son **observaciones provisionales**: generan avisos, nunca cambian rasgos.

## 5. Coste en tokens (medido sobre el código actual)

- Instrucciones de la lectura de capítulo (`DIGEST_INSTRUCTIONS`): ≈2.700 caracteres, ≈760
  tokens. Un capítulo de ≈2.500 palabras suma ≈4.300; la lectura cuesta ≈5.000 tokens de entrada.
- El añadido de `traits`: ≈250 caracteres de instrucciones (≈70 tokens de entrada, **+1,5 %**) y
  3 a 8 rasgos observados por capítulo, de unos 35 tokens cada uno: **≈100–300 tokens de salida
  por capítulo**. Va con el modelo económico de las lecturas.
- **Reutilización:** la lectura solo se repite cuando el capítulo cambia de verdad (el mecanismo
  actual de lectura automática). Las fichas ya hechas no se rehacen: el nivel A, sin IA, cubre
  todos los capítulos desde el primer día, y el nivel B se va completando a medida que los
  capítulos se releen. Releer toda una novela de 30 capítulos para tener los rasgos al instante
  sería opcional y explícito (≈150.000 tokens de entrada con el modelo económico), con su coste
  anunciado antes.
- Medición real en la implementación: una prueba como `tests/e2e/tokens.test.mjs` antes y
  después, y el registro `ai_usage`.

## 6. Cambios legítimos, retrospectivas y evolución

- Se compara con el rasgo **vigente en la fecha del pasaje** (sección 3).
- Si el texto coincide con un rasgo **posterior**, el aviso es «¿cambio adelantado? Según la
  ficha, ocurre desde 2019».
- Si coincide con uno **anterior** dentro de una retrospectiva, no hay aviso.
- Rasgos `gradual`: solo saltos imposibles (por ejemplo, de «delgada» a «obesidad mórbida» en
  dos semanas narrativas).
- Retrospectiva dentro de un capítulo: una fase posterior permitirá dar fecha a una escena (en
  su separador), con la misma lógica.
- El «arco narrativo» y la personalidad no se comprueban automáticamente: eso sigue siendo del
  Consejero.

## 7. Avisos: discretos y comprensibles

- **Nunca durante la escritura:** se calculan al guardar o al salir del capítulo y no abren nada.
- **Una marca pequeña:** junto a *Cronología* en la lista de capítulos, «· 2 avisos» (como las
  advertencias de tiempo de hoy). Dentro, el panel *Coherencia de personajes*.
- **Cada aviso en una frase**, con la cita y su porqué:
  > En el capítulo 7 (2026), «Claudia, con su obesidad mórbida» — su ficha dice «delgada».
- **Acciones:** *Ir al pasaje* · *Es un cambio* (crea un rasgo «desde esta fecha», que el autor
  confirma) · *Es retrospectiva* (marca el capítulo) · *Ignorar*.
- **Ignorar es estable:** usa `dismissed_warnings` con huella, como la Cronología; el aviso solo
  vuelve si cambia el texto.
- El Consejero, al analizar *coherencia*, recibe los avisos abiertos como datos.

## 8. Base de datos (a presentar y autorizar en su momento)

- `alter table public.novels add column if not exists present jsonb;`
- `create table if not exists public.character_traits (…)`, con RLS, sin permisos para las
  claves públicas y `updated_at`, como las demás tablas (`procesador_secure_table`).
- La columna `traits` de la lectura de capítulo, dentro del JSON que ya se guarda, o una columna
  `jsonb` aditiva.

Todo será aditivo e idempotente. El SQL literal se presentará antes de aplicarlo.

## 9. Fases

1. Año presente, la herencia correcta tras las retrospectivas y la edad escrita en el manuscrito.
2. Rasgos con vigencia por fecha, sugerencias desde la descripción y detección sin IA.
3. Rasgos observados en la lectura de capítulos.
4. Panel de avisos y su uso en el Consejero.

## 10. Pruebas previstas

- «Claudia era delgada» en la ficha y «Claudia, con su obesidad mórbida» en el capítulo 7: avisa.
- «Su madre, obesa, miraba a Claudia»: no avisa (describe a otra persona).
- «Claudia y Marta…; ella estaba muy gorda»: no avisa (pronombre ambiguo).
- Cambio aprobado «obesidad mórbida desde 2024»: no avisa en 2026; en una retrospectiva a 2010,
  «obesidad mórbida» sí avisa y «delgada» no.
- «Claudia recordó cuando era gorda»: no avisa.
- En diálogo: avisa como «dicho por un personaje».
- Con presente 2026 y nacimiento en 1990, «Claudia, de 40 años» avisa (tiene 35 o 36); una
  novela sin presente no cambia su comportamiento.
- Ignorar un aviso: no vuelve hasta que cambia el texto.
- Ninguna acción modifica el manuscrito.
