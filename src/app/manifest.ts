import type { MetadataRoute } from "next";

/** PWA instalable: conserva la autenticación y requiere conexión para editar y usar IA. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Procesador",
    short_name: "Procesador",
    description: "Escritura de ficción con asistencia de IA",
    start_url: "/",
    display: "standalone",
    scope: "/",
    id: "/",
    background_color: "#fbf9f5",
    theme_color: "#6b2a2a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
