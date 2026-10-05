# Formato del texto: cursivas y separadores de escena

> Estado: **implementado (Fase 1 del plan profesional).** Base para la futura exportación (DOCX, EPUB, PDF).

## Problema

Un capítulo era texto plano. No había forma de marcar una cursiva (títulos de obras, extranjerismos, énfasis, pensamientos) ni un cambio de escena, y una novela sin eso no se puede publicar. Toda la aplicación trabaja con posiciones de carácter sobre ese texto: cursor, selección, citas de las fichas, referencias del Consejero y marcadores de imagen.

## Decisión

**El texto sigue siendo texto plano**, con un marcado mínimo dentro. No se cambia el `<textarea>` por un editor enriquecido: rompería las posiciones de las que dependen las fichas, el Consejero y las imágenes, y obligaría a migrar los capítulos existentes. Con este formato ningún capítulo cambia y no hay migración de base de datos.

| Elemento | Cómo se escribe | Reglas |
|---|---|---|
| Cursiva | `*así*` | Un asterisco a cada lado, dentro de un mismo párrafo (nunca cruza una línea). El asterisco de apertura va pegado a la palabra que sigue y el de cierre a la que precede. Una pareja de dos o más asteriscos (`**`, `***`) nunca es cursiva. `\*` es un asterisco literal. Un asterisco sin pareja es sólo un asterisco. |
| Separador de escena | `[[separador]]` en su propia línea | Igual que una imagen (`[[imagen:…]]`): es un bloque sólo si ocupa la línea entera. Dentro de un párrafo es texto. |

No hay negritas, títulos ni listas: no forman parte de la prosa de una novela.

Las reglas están en `src/lib/manuscript.ts` (`blocks`, `inlineSpans`, `toggleItalic`, `proseOnly`, `forModel`, `fromModel`), que leen el editor, el servidor, la IA y la futura exportación.

## En el editor

- **Cursiva:** `Ctrl/⌘+I`, o el botón *C* de la barra.
  - Con texto seleccionado, lo pone en cursiva sin incluir los espacios de los bordes; si la selección abarca varios párrafos, cada uno lleva su cursiva, y las líneas de imagen o separador no se tocan.
  - Si la selección es una cursiva (con o sin sus asteriscos), o el cursor está dentro de una, la quita.
  - Sin selección, abre una pareja `**` con el cursor en medio.
- **Separador de escena:** el botón ⁂ de la barra inserta `[[separador]]` como párrafo propio en el cursor.
- Escribir sobre la línea de un separador abre un párrafo nuevo debajo, como con las imágenes: el marcador nunca se rompe.
- Todo se puede deshacer con `Ctrl/⌘+Z`. Los botones no quitan el foco al texto, así que la selección se conserva, también en el teléfono.
- El editor muestra el marcado tal cual; la vista **Lectura** lo dibuja: cursivas reales y un `* * *` centrado en cada cambio de escena.

## Con la IA

Los modelos leen el formato y lo escriben (`TEXT_FORMAT` en `src/lib/ai/prompts.ts`, en las instrucciones de editar y de escribir):

- Las cursivas viajan tal cual, `*así*`. Se les pide conservarlas al reescribir y usarlas en prosa nueva sólo donde la novela lo haría.
- Un separador llega como la línea `* * *`, la convención habitual de la prosa. El modelo nunca ve `[[separador]]` (`forModel`, aplicado al texto del Asistente, del Consejero y de las fichas de lectura).
- Lo que escribe un modelo pasa por `fromModel` antes de llegar al manuscrito (Insertar en el cursor, Reemplazar selección): una línea `* * *`, `***`, `⁂` o `#` se convierte en `[[separador]]`, y una negrita `**así**` en cursiva.
  - Consecuencia: si el autor tenía un `***` escrito a mano y pide reescribir ese fragmento, vuelve como separador. Es lo que ese `***` significaba.
- *Copiar* copia la propuesta tal como la escribió el modelo, para pegarla fuera de Procesador.

## Recuentos, citas y Consejero

- El recuento de palabras no cuenta separadores ni asteriscos sueltos.
- Una cita del Consejero se encuentra aunque el modelo la escriba sin los asteriscos de la cursiva (`findQuote` los ignora), e *Ir* selecciona el pasaje aunque la cita no coincida carácter a carácter.
- Las estadísticas (repeticiones, ecos, presencia) y la frescura de las fichas tratan el separador como un espacio, igual que una imagen.

## Presentación: el texto guardado y el libro

El texto guardado es la **estructura**; cómo se ve como libro es **presentación**, y una sola
función la decide para *Lectura* y para la exportación (`present` en `src/lib/presentation.ts`).
El texto nunca se modifica para conseguirla.

| En el texto guardado | En *Lectura* y en el libro |
|---|---|
| Una línea con texto | Un párrafo. Los diálogos son párrafos normales. |
| Párrafos separados por un Enter, por una línea en blanco o por varias | Lo mismo: párrafos seguidos, **sin espacio entre ellos**. Las líneas en blanco son sólo la forma de teclear. |
| Espacios o tabuladores al empezar una línea | Se descartan: la sangría la pone la maqueta. |
| Una línea que parece vacía pero tiene caracteres invisibles (espacio de ancho cero, BOM, guion blando, marcas de dirección; suelen venir al pegar de Word, Google Docs o la web) | Es una línea en blanco: nunca un párrafo vacío (que se vería como una línea entera de hueco). Dentro de un párrafo el texto queda tal cual. |
| Primer párrafo del capítulo, o tras un separador o una imagen | Sin sangría. Los demás, con sangría de primera línea (1,5 em en pantalla). |
| `[[separador]]` | Espacio deliberado antes y después (≈ una línea en blanco a cada lado) y `* * *` centrado. |

*Lectura* muestra además el arranque del capítulo como en el libro («CAPÍTULO 3» y el título
propio del autor; el título por defecto «Capítulo 3» no se repite), en una columna de unos 65
caracteres (34 em) con interlineado de novela, 1,45 (27,5 px a 19 px), sin márgenes entre párrafos. Diálogo y narración siguen el mismo ritmo: ninguna regla de espaciado propia para el diálogo.

Criterio comprobado en Chromium (`tests/e2e/format.test.mjs`): entre la última línea de un
párrafo y la primera del siguiente hay exactamente un interlineado, igual que entre dos líneas
del mismo párrafo (narración → narración, narración → diálogo, diálogo → diálogo, diálogo →
narración), escriba el autor uno o dos Enter; sólo `[[separador]]` abre espacio (más de 2,5
líneas, con el ornamento en medio).

Consecuencia: un salto de línea **dentro** de un párrafo (versos, una carta con líneas cortas)
se presenta como párrafos distintos. Si hace falta, se añadirá un marcado propio para ello
([deuda](deuda.md)); no se representa con líneas en blanco.

Un futuro editor visual debe pintar el texto con esta misma presentación (`present`), sin
cambiar cómo se guarda.

## Para la exportación

- `blocks(text)` da la secuencia de bloques: texto, imagen y separador.
- `inlineSpans(párrafo)` da cada párrafo como tramos `{ text, italic }`, sin asteriscos ni escapes.
- `present(text)` (`src/lib/presentation.ts`) junta ambos con las reglas de la presentación: párrafos, cuáles van sin sangría, separadores e imágenes. Es lo que usan *Lectura* y los exportadores.
- Un exportador recorre ambos: `<em>`/`<i>` o la cursiva de Word para los tramos en cursiva; para el separador, un `* * *` o un ornamento centrado con espacio antes y después (EPUB: un `<hr>` con estilo; DOCX/PDF: un párrafo centrado).

## Fuera de esta fase

- Versalitas, notas al pie y otros estilos de carácter.
- Avisar de un `[[separador]]` escrito dentro de un párrafo, como ya se hace con las imágenes.
- Convertir automáticamente los `***` que el autor escribió a mano antes de que existiera el separador.
