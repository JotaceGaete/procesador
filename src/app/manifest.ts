import type { MetadataRoute } from "next";

/**
 * Only the icons and the name for a shortcut («Añadir a pantalla de inicio», «Crear acceso
 * directo»); docs/icono.md. `display: "browser"`: the shortcut opens Procesador in the browser,
 * as today; it does not turn it into an installed app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Procesador",
    short_name: "Procesador",
    description: "Escritura de ficción con asistencia de IA",
    start_url: "/",
    display: "browser",
    background_color: "#fbf9f5",
    theme_color: "#6b2a2a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
