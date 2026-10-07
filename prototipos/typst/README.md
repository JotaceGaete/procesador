# Prototipo Typst · «Ver libro» (Fase 0, descartable)

> Rama `claude/prototipo-typst`, sobre `24250f6`. **No es parte de la aplicación:** no toca
> Supabase, ni el editor, ni ninguna ruta de Procesador. Sólo añade esta carpeta y una página de
> prueba estática en `public/prototipo-typst/`. Se puede borrar entera.

Pregunta: ¿sirve Typst como **motor único** para la vista paginada («Ver libro») y para el PDF de
imprenta, ejecutándose en el navegador (WebAssembly)?

## Versión

- **typst.ts 0.7.0** (`@myriaddreamin/typst.ts`, `typst-ts-web-compiler`, `typst-ts-renderer`;
  Apache-2.0), que lleva **Typst 0.14.2** (el PDF lo confirma: `Creator: Typst 0.14.2`).
- Fuente: **Libertinus Serif** (OFL 1.1; licencia en `public/prototipo-typst/fonts/OFL-Libertinus.txt`),
  la misma en pantalla y en el PDF. Ninguna fuente del sistema ni de un CDN.

## Arquitectura

```
novela (JSON de datos)  ──►  src/book.typ (plantilla Typst)  ──►  Typst (WASM)
                                                                    ├─ vector → renderizador → <canvas> por página
                                                                    ├─ query <pagemap> → párrafo → página
                                                                    └─ PDF (la misma composición)
```

| Archivo | Qué hace |
|---|---|
| `src/novel.mjs` | Novelas sintéticas deterministas (50k–200k palabras): diálogos, cursivas, separadores, imágenes ancha / en línea / vertical / de página completa con pie y crédito, notas al pie de prueba, Unicode poco común |
| `src/book.typ` | La plantilla: página real (6 × 9 in), márgenes espejo, cornisas, numeración, capítulos en página derecha, separadores, imágenes, notas, viudas y huérfanas, preliminares e índice, y el mapa párrafo → página |
| `src/engine.mjs` | Compilador y renderizador en el navegador; compila, consulta el mapa y exporta en una sola instantánea; dibuja una página suelta en un `<canvas>` |
| `src/chapters.mjs` | Componer **capítulo a capítulo** (caché por capítulo) y comprobar que da lo mismo que el libro entero |
| `src/app.mjs`, `src/index.html` | La página de prueba (también para el iPhone) |
| `bench/` | Banco de pruebas: Chromium (`browser.mjs`), nativo (`native.mjs`), por capítulos (`node-chapters.mjs`), viudas y huérfanas en el PDF (`widows.py`), PDF = composición (`pdfcheck.mjs`) |

El texto del autor llega a Typst **como datos** (cadenas de un JSON), nunca como marcado: nada de lo
que se escribe se interpreta.

## Cómo ejecutarlo

```sh
cd prototipos/typst && npm install
node build.mjs --vendor          # public/prototipo-typst/app.js (+ WASM local en vendor/, no versionado)
node bench/browser.mjs           # Chromium: 50k / 100k / 200k, por capítulos, PDF, teléfono
node bench/native.mjs /tmp       # Typst nativo (referencia del servidor)
```

Desplegada (vista previa de Vercel de esta rama), la página es `/prototipo-typst/index.html`
(pide la contraseña de Procesador) y carga el WASM desde jsDelivr.

## Resultados (Chromium 141 headless en la máquina de desarrollo, sin GPU)

### Descarga (primera visita; después, caché del navegador)

| Archivo | Sin comprimir | brotli | gzip |
|---|---|---|---|
| Compilador Typst (WASM) | 28,3 MB | **8,1 MB** | 10,8 MB |
| Renderizador (WASM) | 0,97 MB | 0,30 MB | 0,36 MB |
| Libertinus Serif (4 archivos) | 1,25 MB | 0,87 MB | — |
| Página (JS) | 0,14 MB | 0,03 MB | 0,04 MB |
| **Total** | **30,7 MB** | **≈ 9,3 MB** | ≈ 12 MB |

Iniciar el compilador una vez descargado: **0,3–0,6 s** (instanciar 28 MB de WASM).

### El libro entero de una vez

| | 50k | 100k | 200k |
|---|---|---|---|
| Páginas | 150 | 299 | 579 |
| Primera composición (WASM) | 2,2 s | 3,7 s | 7,3 s |
| Exportar para el visor | 0,3 s | 0,6 s | 1,0 s |
| Recomponer tras editar un capítulo | 1,3 s | 2,7 s | 6,1 s |
| Memoria (proceso de la página) | 364 MB | 484 MB | 720 MB |
| Nativo (servidor), primera composición | 0,43 s | 0,72 s | 1,56 s |

WASM es ≈ 5 veces más lento que nativo. Recomponer el libro entero cuesta casi lo mismo que
componerlo: así **no** sirve para editar y volver a mirar.

### Por capítulos (la arquitectura recomendada)

| | 50k | 100k | 200k |
|---|---|---|---|
| **Primer capítulo en pantalla** | **0,62 s** | **0,61 s** | **0,74 s** |
| Todos los capítulos (en segundo plano) | 2,0 s | 3,1 s | 6,5 s |
| Por capítulo (media / máx.) | 143 / 238 ms | 105 / 180 ms | 114 / 255 ms |
| **Recomponer el capítulo editado** | **112 ms** | **105 ms** | **126 ms** |
| Memoria | 277 MB | 317 MB | 394 MB |

**Igual al libro entero:** con capítulos en página derecha y en página siguiente, 50k y 100k: el
mismo comienzo de cada capítulo, las mismas páginas en blanco, el mismo índice, el mismo total y
**cada párrafo en la misma página** (901 y 1.787 párrafos). Funciona porque la caja de texto mide
lo mismo en pares e impares (la composición de un capítulo no depende de su paridad) y porque lo
que depende del libro entero se calcula fuera: el número de la primera página, las páginas en
blanco y el índice. **Hallazgo:** la numeración de las notas tiene que reiniciarse por capítulo (o
pasarse como dato): un «12» ocupa más que un «1» y cambiaba un corte de línea.

### Dibujar sólo lo visible

Cada página se dibuja aparte en un `<canvas>`: **15–60 ms** por página (≈ 200 ms la primera, con
200k), **45–105 ms** por doble página al avanzar. El coste no depende del tamaño del libro.

### PDF

- Mismo motor y misma composición: 579 páginas, **432 × 648 pt** (6 × 9 in exactas), Libertinus
  **incrustada** (subconjunto), PDF 1.7 etiquetado; 200k en 1,7 s (WASM).
- **Comprobado:** 146 párrafos muestreados están en la página que dice el mapa; el PDF hecho en el
  navegador y el nativo tienen **el mismo texto en cada página** (83 páginas comparadas, 0 diferencias).
- Imágenes con su resolución original dentro del PDF (467–592 ppp en estos ejemplos).

## Qué se comprobó en la composición

- **Español y Unicode:** partición silábica en español, «comillas», ¿¡, ñ, ü, Œ, Æ, Ł, griego,
  cirílico, × ≈ —, ligaduras *fi*/*fl*. Libertinus no tiene emoji (no se probó: un emoji saldría
  como un cuadrado; habría que añadir una fuente de emoji o avisar).
- **Cursivas** reales; **separador** `* * *` que nunca queda solo al pie (va con lo que sigue).
- **Márgenes espejo** medidos en el PDF: página par 45 / 60 pt, impar 62 / 43 pt (exterior 16 mm,
  interior 22 mm).
- **Cornisa**: autor en pares, título en impares; **número** en el lado exterior. Ninguno en
  preliminares, en la página que abre capítulo, en las páginas en blanco ni en las de imagen.
- **Capítulo en página derecha** con página en blanco cuando hace falta; el primero siempre a la derecha.
- **Preliminares:** portadilla, portada, créditos al dorso, dedicatoria, epígrafe e **índice con
  números de página** (del propio documento o calculado fuera).
- **Notas al pie** en la misma página que su llamada, con filete.
- **Viudas y huérfanas:** 0 huérfanas; 3 viudas en 516 páginas (200k), 2 de ellas porque la línea
  lleva una llamada de nota y Typst prioriza que llamada y nota estén en la misma página. Control:
  la misma novela sin la regla tiene 14 huérfanas y 15 viudas en 127 páginas.
- **Imágenes:** ancha, en línea, vertical alta (limitada al 75 % de la caja para que quepa con su
  pie, calculado con sus píxeles, sin medir) y de página completa (su propia página, sin cornisa ni
  número). Si una imagen no cabe pasa a la página siguiente y deja hueco; con «imágenes flotantes»
  sube o baja en la página y el texto llena el hueco (el orden exacto texto/imagen se pierde). Las dos
  funcionan.
- **Párrafo → página:** una marca invisible por párrafo y una consulta al final (≈ 0,2 s con 200k
  en nativo; en la arquitectura por capítulos es por capítulo y casi gratis).

## Lo que encontré por el camino

1. Una cornisa que pregunta, en cada página, por todo el documento, hace que Typst repita la
   maquetación: 200k pasó de 9,8 s a 1,56 s (nativo) al cambiarla por un estado que se pone y se
   quita al principio y al final de cada capítulo. **La plantilla debe evitar consultas por página.**
2. `compiler.query()` de typst.ts 0.7.0 no funciona tal cual (consulta un mundo sin compilar y
   analiza el JSON dos veces); se usa `runWithWorld` (compilar, consultar y exportar en una sola
   instantánea).
3. El renderizador necesita el contexto 2D del `<canvas>` (no el elemento) y su tamaño antes.

## Qué falta probar en un iPhone real (no puedo medir WebKit desde aquí)

Página: `https://<vista previa de la rama>/prototipo-typst/index.html` (primero entrar con la contraseña).

1. **Wi-Fi y luego 4G/5G:** pulsar **50.000 palabras**. Anotar el «Inicio» (descarga + arranque).
   La descarga son ≈ 9 MB la primera vez.
2. **50.000, 100.000 y 200.000:** anotar «Primera composición» y «Recomponer». Si Safari recarga la
   página («Se ha recargado esta página porque hubo un problema»), es **memoria**: anotar en qué tamaño.
3. **Por capítulos (200k):** anotar «primer capítulo en pantalla», «por capítulo» y «recomponer el
   capítulo editado». Es la cifra que decide.
4. **Navegar:** Siguiente / Anterior y deslizar; ¿fluido? Girar el teléfono (en horizontal y en
   iPad, doble página si cabe).
5. **Ir al párrafo** `c10p5`: debe saltar a su página.
6. **Descargar PDF** (con 50k): abrirlo en Archivos; ¿se ve igual que en pantalla?
7. **Copiar resultados** y pegármelos (JSON con todas las cifras y el modelo de iPhone por el agente
   de usuario).

Umbrales razonables para dar el «sí» en iPhone: primer capítulo en menos de ~2 s, un capítulo en
menos de ~0,5 s, 200k sin recarga de Safari.
