import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Procesador",
  description: "Escritura de ficción con asistencia de IA",
  applicationName: "Procesador",
  appleWebApp: { capable: true, title: "Procesador", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

// On Android the on-screen keyboard shrinks the layout (so the Asistente's sheet stays
// above it instead of behind it). iOS ignores this; the panel follows visualViewport there.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
