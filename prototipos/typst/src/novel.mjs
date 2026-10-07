// PROTOTIPO (Fase 0, descartable): novelas sintéticas deterministas para medir Typst.
// El mismo código corre en Node (bench) y en el navegador (página de prueba).
//
// Forma del libro (los datos que recibe la plantilla book.typ, como JSON):
//   { title, author, subtitle, publisher, year, dedication, epigraph, epigraphSource,
//     layout: { width, height (mm), margins {top,bottom,inside,outside} (mm), fontSize (pt),
//               leading (em), indent (mm), chapterStart: "right" | "next", runningHead },
//     front: bool, firstPage: número de la primera página (para componer por capítulos),
//     chapters: [{ n, title, blocks: [
//        { k: "p", id, first, s: [[tipo, texto]] }   tipo: "t" texto, "i" cursiva, "n" nota al pie
//        { k: "break" }
//        { k: "img", id, src, width (%), px [ancho, alto], align, page (bool), caption, credit } ] }] }

const NARRATION = [
  "El viento traía olor a sal y a gasoil desde el muelle, donde los pescadores ya no esperaban a nadie.",
  "Pilar dejó la taza sobre la mesa sin hacer ruido, como si el silencio fuera lo único que todavía le pertenecía.",
  "Afuera, en la casa de ahora, el refrigerador volvió a sonar y ninguno de los dos se movió para apagar la pantalla.",
  "Héctor soltó una risa baja, pero no tocó el teléfono; sabía que cualquier gesto sería una confesión.",
  "La lluvia de agosto había dejado charcos en el patio, y en cada uno flotaba un pedazo de cielo gris.",
  "Recordó la cocina de su abuela en Valparaíso: el pan amasado, la radio encendida, el reloj que nunca dio la hora correcta.",
  "Nadie en el pueblo hablaba del incendio, aunque todos sabían quién había dejado la puerta abierta aquella noche.",
  "Camila subió las escaleras de dos en dos, con el corazón golpeándole las costillas y la carta todavía en el bolsillo.",
  "El tren llegó con veinte minutos de retraso, y en el andén sólo quedaban una mujer con un paraguas y un perro sin dueño.",
  "Había algo en la manera en que él pronunciaba su nombre que la obligaba a mirar hacia otro lado.",
  "La habitación olía a madera húmeda, a libros viejos y a una colonia barata que ella reconoció de inmediato.",
  "Pasaron tres inviernos antes de que alguien se atreviera a abrir el baúl del desván.",
];
const DIALOGUE = [
  "—¿Vas a seguir callada? —preguntó él.",
  "—No fue trampa.",
  "—Fue pánico —dijo Pilar, sin levantar la vista.",
  "—¿Y si nos equivocamos? ¿Y si todo esto fue en vano?",
  "—Siempre dices lo mismo —respondió ella—. Siempre.",
  "—¡Basta ya! —gritó desde la puerta.",
  "—Mañana, quizá. O nunca.",
];
const ITALIC = ["nunca", "sal", "otra vez", "la casa", "ahora", "Lux aeterna", "déjà vu"];
const TITLES = ["El intento", "La joven", "Confesiones", "El muelle", "Agosto", "", "La carta", "", "Valparaíso, 1972", "El desván", ""];
const UNICODE =
  "Una línea con caracteres poco comunes: «comillas latinas», “inglesas”, ‘simples’; ¿preguntas? ¡exclamaciones!; ñandú, pingüino, Œuvre, façade, Ærø, Łódź, λόγος, мир, 3 × 4 ≈ 12 — y la ligadura de «difícil», «afinar», «flor».";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Paragraph spans: narration with an occasional italic word and, rarely, a footnote. */
function paragraph(r, footnote) {
  const out = [];
  const n = 2 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const sentence = NARRATION[Math.floor(r() * NARRATION.length)];
    if (r() < 0.25) {
      const it = ITALIC[Math.floor(r() * ITALIC.length)];
      const cut = sentence.indexOf(" ", Math.floor(sentence.length / 2));
      out.push(["t", `${i ? " " : ""}${sentence.slice(0, cut)} `], ["i", it], ["t", sentence.slice(cut)]);
    } else out.push(["t", `${i ? " " : ""}${sentence}`]);
  }
  if (footnote) out.push(["n", footnote]);
  return out;
}

/**
 * A novel of about `target` words: chapters of ~3.500 words, dialogue, italics, a scene break
 * every ~1.300 words, an image every few chapters (inline, wide, tall and full page, with caption
 * and credit), one or two footnotes per chapter, and a paragraph of uncommon Unicode.
 */
export function novel(target, { seed = 7, chapterWords = 3500, layout = {}, imageEvery = 6 } = {}) {
  const r = rng(seed);
  const count = Math.max(1, Math.round(target / chapterWords));
  const chapters = [];
  let total = 0;
  for (let c = 0; c < count; c++) {
    const blocks = [];
    let w = 0;
    let sinceBreak = 0;
    let p = 0;
    let first = true;
    let notes = 0;
    const want = target / count;
    const imageAt = c % imageEvery === Math.min(1, imageEvery - 1) ? Math.floor(want * 0.4) : -1;
    let imageDone = false;
    while (w < want) {
      if (!imageDone && imageAt >= 0 && w >= imageAt) {
        imageDone = true;
        const kind = Math.floor(c / imageEvery) % 4;
        blocks.push({
          k: "img",
          id: `img${c}`,
          src: ["wide", "inline", "tall", "page"][kind],
          width: [100, 60, 75, 100][kind],
          align: "center",
          page: kind === 3,
          px: IMAGE_SIZES[["wide", "inline", "tall", "page"][kind]],
          caption: `Figura del capítulo ${c + 1}: el puerto al amanecer, visto desde la casa de la abuela.`,
          credit: "Foto: Archivo familiar",
        });
        first = true;
        continue;
      }
      if (sinceBreak > 1300 && r() < 0.5) {
        blocks.push({ k: "break" });
        sinceBreak = 0;
        first = true;
        continue;
      }
      const dialogue = !first && r() < 0.35;
      const note = !dialogue && notes < 2 && r() < 0.04 ? `Nota de prueba ${c + 1}.${notes + 1}: en la edición de 1972 este pasaje decía «la casa del puerto»; la autora lo cambió en la segunda.` : null;
      if (note) notes++;
      const s =
        c === 0 && p === 3
          ? [["t", UNICODE]]
          : dialogue
            ? [["t", DIALOGUE[Math.floor(r() * DIALOGUE.length)]]]
            : paragraph(r, note);
      const pw = s.reduce((n, [k, t]) => n + (k === "n" ? 0 : words(t)), 0);
      blocks.push({ k: "p", id: `c${c}p${p++}`, first, s });
      first = false;
      w += pw;
      sinceBreak += pw;
    }
    total += w;
    chapters.push({ n: c + 1, title: TITLES[c % TITLES.length], blocks });
  }
  return {
    title: "La casa del puerto",
    subtitle: "Novela",
    author: "Ana Pérez Lagos",
    publisher: "Ediciones del Muelle",
    year: "2026",
    dedication: "A mi abuela, que guardaba las cartas en el desván.",
    epigraph: "Nadie se baña dos veces en el mismo río.",
    epigraphSource: "Heráclito",
    layout: {
      width: 152.4,
      height: 228.6,
      margins: { top: 20, bottom: 20, inside: 22, outside: 16 },
      fontSize: 11,
      leading: 0.62,
      indent: 6,
      chapterStart: "right",
      runningHead: true,
      ...layout,
    },
    front: true,
    firstPage: 1,
    words: total,
    chapters,
  };
}

/** Synthetic image files (PNG) the template needs, by name: width × height in pixels. */
export const IMAGE_SIZES = { wide: [2400, 1200], inline: [1600, 1200], tall: [1200, 2600], page: [1800, 2700] };
