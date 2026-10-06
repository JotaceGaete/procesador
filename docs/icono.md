# Icono de Procesador

## Diseño

Una **P cuya asta termina en el plumín de una pluma estilográfica**, en crema (`#f6efe3`) sobre
borgoña oscuro (`#6b2a2a`), en un cuadrado de esquinas redondeadas.

- **Literario, no tecnológico:** el plumín es el gesto de escribir a mano; la P es el nombre.
  No hay chispas, cerebros ni circuitos de «IA».
- **Legible a 16 px:** a ese tamaño queda una P maciza de alto contraste; el plumín se insinúa
  en la punta del asta. A 32 px aparece la ranura; a 48 px y más, el respiradero del plumín.
  El SVG se simplifica solo según el tamaño al que se dibuja (`@media (max-width: …)` dentro
  del propio SVG).
- **Colores:** el borgoña es de la familia del acento de la interfaz (`#7a4a2e`), más profundo
  para que destaque en pestañas claras y oscuras; el crema es el del papel (`#fbf9f5`). Se
  probaron también azul tinta (se pierde sobre la barra oscura de Chrome) y un plumín solo
  (a 16 px se lee como un escudo o una gota).

La interfaz no cambia: no hay `theme-color` en las páginas ni colores nuevos en `globals.css`.

## Archivos

Todos salen de un único dibujo en `scripts/icons.mjs` (`npm run icons` los regenera; se
guardan en el repositorio):

| Archivo | Para qué |
|---|---|
| `src/app/icon.svg` | Favicon de la pestaña (Chrome, Firefox, Edge) |
| `src/app/favicon.ico` | 16, 32 y 48 px: Safari y quien pida `/favicon.ico` |
| `src/app/apple-icon.png` | 180 px, a sangre: acceso directo en iPhone/iPad (iOS redondea las esquinas) |
| `public/icons/icon-192.png`, `icon-512.png` | Accesos directos (manifiesto) |
| `public/icons/icon-maskable-512.png` | Android: el dibujo dentro de la zona segura del 80 % |
| `src/app/manifest.ts` | `/manifest.webmanifest`: nombre e iconos para «Añadir a pantalla de inicio» / «Crear acceso directo» |

Next.js genera las etiquetas `<link rel="icon">`, `apple-touch-icon` y `manifest` a partir de
esos archivos, con una URL que cambia con el contenido (`/icon.svg?icon.<hash>.svg`).

El manifiesto usa `display: "browser"`: el acceso directo abre Procesador en el navegador, como
hoy; no lo convierte en una aplicación instalada.

`src/proxy.ts` deja pasar sin sesión sólo esas rutas (`/favicon.ico`, `/icon.svg`,
`/apple-icon.png`, `/manifest.webmanifest`, `/icons/…`): la página de entrada muestra el icono y
los navegadores descargan el manifiesto sin cookies. Todo lo demás sigue cerrado
(`tests/e2e/icon.test.mjs`).

## Caché

Los navegadores guardan el favicon aparte y a veces mucho tiempo.

- El SVG y el icono de Apple llevan la versión en la URL, así que un dibujo nuevo es una URL
  nueva; pero un navegador que ya guardó «no hay icono» para el sitio puede tardar en pedirlo.
- Para forzarlo: recargar sin caché (`Ctrl+Shift+R` / `⌘+Shift+R`); abrir directamente
  `https://<dominio>/icon.svg` y luego recargar la página; o cerrar y abrir la pestaña.
- Chrome: si persiste, borrar «Imágenes y archivos en caché» del sitio (candado → Configuración
  del sitio → Borrar datos). Safari guarda los favicons en su propia base: puede requerir
  vaciar cachés o reiniciar Safari.
- Un acceso directo ya creado conserva el icono con el que se creó: hay que borrarlo y crearlo
  de nuevo.
