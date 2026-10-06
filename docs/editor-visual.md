# Editor visual · Fase A (prueba de viabilidad)

> Estado: **Fase A terminada, detrás de un interruptor.** El editor de texto plano sigue siendo
> el predeterminado. Sin cambios en el modelo de datos ni en Supabase.

## Objetivo

Demostrar que Procesador puede representar y editar un libro **visualmente**: el autor trabaja
viendo los elementos editoriales reales, no su representación técnica. La prueba central:

> párrafo → **imagen real** → **pie y crédito** → párrafo → **separador visible** → párrafo

editable en su sitio, sin que se vea nunca `[[imagen:…]]`, `[[separador]]` ni los asteriscos
de la cursiva.

No es un procesador de texto genérico: sólo existen los elementos del libro (párrafo, cursiva,
imagen, separador). Sin fuentes, tamaños, negritas ni listas.

## Cómo se activa

- En la lista de capítulos: **Editor visual (prueba): no / sí**. Se recuerda en ese dispositivo.
- O con la dirección: `…/novela/<id>?editor=visual` (y `?editor=texto` para volver).
- Al cambiar, el texto se guarda primero y el otro editor abre ese mismo texto.

## Arquitectura

| Pieza | Qué hace |
|---|---|
| `src/lib/visual/document.ts` | Esquema ProseMirror (párrafo con cursiva, imagen, separador) y la conversión `content ⇄ documento`, más el mapa de posiciones documento ⇄ desplazamientos en el texto. Puro, sin navegador. |
| `src/components/VisualEditor.tsx` | El editor: ProseMirror con historial propio (deshacer/rehacer), la imagen dibujada desde `manuscript_images` y el mismo contrato (`EditorHandle`) que el editor de texto. |
| `src/lib/visual/report.ts`, `scripts/visual-roundtrip.ts` | El informe de conversión sobre capítulos reales (sólo lectura). |

**`chapters.content` sigue siendo la fuente de verdad, en el formato de hoy.** El documento es
una vista sin pérdida de ese texto:

- cada bloque guarda **su línea original** (`raw`) y **el texto exacto que lo precede**
  (`before`: saltos, líneas en blanco, líneas de caracteres invisibles, CRLF); el documento guarda
  lo que sigue al último;
- al guardar, un bloque que no se tocó se escribe **byte a byte** como estaba; sólo lo editado se
  escribe de nuevo, en la forma canónica (`*cursiva*`, asteriscos literales escapados `\*`,
  `[[imagen:id]]`, `[[separador]]`);
- por eso `toContent(toDoc(c)) === c` para cualquier texto, abrir un capítulo no lo guarda, y
  editar un párrafo cambia sólo esa línea (las versiones y las citas del Consejero no se mueven).

Los párrafos nuevos siguen la costumbre del capítulo (una línea en blanco entre párrafos, o un
solo salto si el capítulo está escrito así).

**El resto de la aplicación no cambia.** El editor visual cumple el mismo `EditorHandle` que
`ChapterEditor`: la selección y el cursor se informan como desplazamientos en `content`, y las
operaciones del Asistente, las versiones, el Consejero («Ir») y las imágenes llegan como cambios
sobre el texto, que el editor aplica reemplazando sólo los bloques distintos, en un único paso
que se puede deshacer. Una selección que empieza o termina en el borde de una cursiva incluye su
asterisco, para no partirla.

La lectura de cada línea es la de Lectura y la exportación (`present()` en
`src/lib/presentation.ts`): lo que se ve al editar es lo que verá el lector.

## Comportamiento

- **Cursiva:** `Ctrl/⌘+I` o el botón *C*. Un asterisco escrito por el autor es un asterisco (se
  guarda escapado y nunca se convierte en cursiva por accidente).
- **Imagen:** el archivo real (copia de pantalla), con su ancho, alineación, pie y crédito. Un clic
  la selecciona y muestra su tarjeta (pie, crédito, texto alternativo, tamaño, quitar…).
  Escribir con una imagen seleccionada **no la reemplaza**: el texto va a un párrafo nuevo después
  (como en el editor de texto, donde escribir sobre la línea de un marcador abre párrafo).
  `Retroceso`/`Supr` la quitan del texto; se deshace.
- **Separador:** el ornamento `* * *` con su espacio; se selecciona y se borra entero.
- **Intro:** nunca apila párrafos vacíos (abrirían un espacio que el libro no tiene); el espacio
  entre escenas lo da el separador.
- **Pegar:** texto en el formato del manuscrito (cursivas, separadores, imágenes) como bloques;
  HTML de Word o de la web conserva párrafos y cursivas y descarta lo demás (negritas, títulos,
  estilos). Un salto de línea al principio o al final del texto pegado abre o cierra párrafo.
- **Copiar:** prosa limpia (párrafos y `* * *`), sin marcadores.
- **Deshacer / rehacer:** `Ctrl/⌘+Z`, `Ctrl/⌘+Mayús+Z` o `Ctrl+Y`, también para lo que aplica el
  Asistente y para restaurar una versión.

## Resultados (Fase A)

- **Conversión:** ida y vuelta idéntica byte a byte en todos los casos probados (textos con CRLF,
  invisibles, espacios raros, marcadores en mayúsculas, emoji, 5.000 textos aleatorios y una
  muestra de 48 capítulos sintéticos). El editor muestra exactamente lo mismo que Lectura.
- **Rendimiento:** capítulo de ~1 MB (8.500 párrafos), escribiendo en el centro: **~25 ms por
  tecla** en Chromium sin GPU (el editor de texto mide 80–86 ms en el mismo entorno).
- Detalle de pruebas y hallazgos: el informe de la Fase A en el PR y `tests/e2e/visual-editor.test.mjs`.

## Hallazgos sobre el formato actual (no son del editor visual)

1. **Líneas de marcador que el formato no reconoce.** Una línea `[[separador]]` o `[[imagen:…]]`
   sólo es un bloque si alrededor tiene espacios o tabuladores. Con fin de línea de Windows (`\r`)
   o un espacio duro delante (` `, frecuente al pegar de Word) es **texto en todas partes**:
   en `blocks()`, en Lectura, en la exportación… y el editor visual lo muestra igual (como texto),
   para no divergir. Corregirlo es una decisión de formato (aceptar cualquier blanco alrededor del
   marcador) que cambia cómo se leen esos capítulos en todas las vistas: queda para decidir, no se
   ha parcheado.
2. **Cursivas junto a un asterisco o una barra invertida literales** (`x\**cursiva*`, `*cursiva\*`)
   no se pueden escribir en el formato. Sin tocar se conservan byte a byte; si el autor edita ese
   párrafo, la forma canónica puede leerlas distinto. El informe los cuenta («párrafos que
   cambiarían al editarlos»). Es igual en el editor de texto.

## Informe sobre capítulos reales

Sólo lectura; nunca escribe en la base ni en los archivos:

```sh
npm run visual:report -- --zip "Mi novela - copia 2026-10-06.zip"   # copia de seguridad de Procesador
npm run visual:report -- --supabase            # todos los capítulos y versiones (SUPABASE_URL y
                                               # SUPABASE_SERVICE_ROLE_KEY en el entorno)
npm run visual:report -- --sample              # la muestra sintética incluida
npm run visual:report -- --zip copia.zip --out informe.md
```

## Fuera de la Fase A

Pies y crédito editables **dentro** de la figura (hoy en su tarjeta, desde `manuscript_images`),
citas, notas al pie, comentarios, buscar y reemplazar, y cualquier cambio de modelo de datos
(Fase B).
