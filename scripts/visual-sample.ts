// A synthetic sample for scripts/visual-roundtrip.ts when no real chapters are given: chapters
// written the ways Procesador's chapters are (typed with one or two Enters, scenes inserted by
// the Asistente, text pasted from Word or the web, Windows line endings, images, scene breaks,
// italics, literal asterisks). Not real chapters: the report says so.
import type { Source } from "../src/lib/visual/report";

const NARRATION = [
  "Llegamos al puerto cuando ya no quedaba nadie en el muelle, y el viento traía olor a sal, a gasoil y a redes mojadas.",
  "Lorena se quedó mirando el agua un largo rato, como si esperara que el barco volviera a aparecer detrás del espigón.",
  "La casa de mi abuela tenía un patio con *buganvillas* y un aljibe que nadie usaba desde la sequía del setenta y dos.",
  "Esa noche leí *Rayuela* hasta tarde, saltando capítulos como se saltan los charcos.",
  "El reloj de la iglesia dio las once y media; en el bar de la esquina alguien apagó la radio a mitad de una canción.",
  "Mi padre decía que el mar no devuelve nada, que sólo presta. Lo decía *en serio*, sin mirarnos.",
];
const DIALOGUE = ["—Siempre dices lo mismo —dije.", "—Porque siempre pasa lo mismo.", "—¿Y si esta vez no?", "—Esta vez tampoco —contestó, sin mirarme.", "—*Ya veremos* —murmuró."];
const ODD = ["El precio era de 5 * 3 = 15 pesos, o eso decía el cartel.", "Escribió **NO** en mayúsculas y lo subrayó dos veces.", "Una nota al margen: \\*sin cursiva\\*.", "Ver [[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]] más arriba."];
const IMG = ["3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10", "00000000-1111-4222-8333-444444444444"];

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function chapter(n: number): string {
  const r = rand(n + 1);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const style = n % 6; // 0 blank lines · 1 one Enter · 2 Word paste · 3 CRLF · 4 Asistente scenes · 5 mixed
  const lines: string[] = [];
  const count = 20 + Math.floor(r() * 60);
  for (let i = 0; i < count; i++) {
    const x = r();
    if (x < 0.55) lines.push(pick(NARRATION));
    else if (x < 0.85) lines.push(pick(DIALOGUE));
    else if (x < 0.9) lines.push("[[separador]]");
    else if (x < 0.94) lines.push(`[[imagen:${pick(IMG)}]]`);
    else if (n % 9 === 0) lines.push(pick(ODD));
    else lines.push(pick(NARRATION));
  }
  if (style === 1) return lines.join("\n");
  if (style === 2) return lines.map((l) => (r() < 0.3 ? ` ${l}` : l)).join(r() < 0.5 ? "\n​\n" : "\n\n");
  if (style === 3) return `${lines.join("\r\n\r\n")}\r\n`;
  if (style === 4) return `${lines.slice(0, 10).join("\n")}\n\n${lines.slice(10).join("\n\n")}\n`;
  if (style === 5) return lines.reduce((acc, l, i) => acc + (i ? (r() < 0.5 ? "\n" : "\n\n\n") : "") + (i % 7 === 0 ? `\t${l}  ` : l), "");
  return lines.join("\n\n");
}

export const SAMPLE: Source[] = Array.from({ length: 48 }, (_, i) => ({ label: `muestra ${String(i + 1).padStart(2, "0")}`, content: chapter(i) }));
