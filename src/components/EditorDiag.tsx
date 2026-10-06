"use client";

/**
 * TEMPORARY (editor visual, Fase A): a diagnostic strip on the editor screen, to find out on a
 * real iPhone which editor runs and why. It reads what already happened; it never chooses an
 * editor. Remove before merging (docs/editor-visual.md).
 *
 *   commit | editor solicitado (and why) | editor montado | preferencia | query editor |
 *   storage | ProseMirror | error | tamaño | user-agent
 */
import { Component, useEffect, useState, type ReactNode } from "react";
import { BUILD } from "@/lib/diag";

/** What the Workspace decided when it started, recorded by it (not recomputed here). */
export const editorDecision = {
  /** «query», «preferencia» or «por defecto» (shown as «visual (por defecto)», «texto (por preferencia)»…). */
  source: "",
  query: null as string | null,
  pref: null as string | null,
  result: "",
};

/** Set by VisualEditor when its ProseMirror view exists; by the boundary when it failed. */
export const visualState = { viewCreated: 0, error: "" };

function storage(): string {
  try {
    const key = "procesador-diag-probe";
    localStorage.setItem(key, "1");
    const ok = localStorage.getItem(key) === "1";
    localStorage.removeItem(key);
    return ok ? "sí" : "no (no se lee lo escrito)";
  } catch (e) {
    return `no (${(e as Error).name})`;
  }
}

/** «por defecto», «por preferencia», «por query»: the source reads as it is, never «por por». */
const source = (s: string) => (!s ? "?" : s.startsWith("por ") ? s : `por ${s}`);

/** «visual (por defecto)»; after the switch, also what it was on opening. */
function solicited(requested: boolean): string {
  const now = requested ? "visual" : "texto";
  const opened = `${editorDecision.result || "?"} (${source(editorDecision.source)})`;
  return editorDecision.result === now ? opened : `${now} (con el interruptor; al abrir: ${opened})`;
}

function read(requested: boolean): [string, string][] {
  const visual = document.querySelector<HTMLElement>(".visual-editor");
  const pm = document.querySelector<HTMLElement>(".visual-editor .visual-text");
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.editor");
  let pref: string;
  try {
    pref = localStorage.getItem("editor") ?? "(nada)";
  } catch (e) {
    pref = `ilegible (${(e as Error).name})`;
  }
  const box = (el: HTMLElement | null) => {
    if (!el) return "";
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)}${el.hidden ? " oculto" : ""}${getComputedStyle(el).display === "none" ? " display:none" : ""}`;
  };
  const mounted = pm ? "visual" : textarea ? "texto (textarea)" : visual ? "visual sin ProseMirror" : "ninguno";
  return [
    ["commit", BUILD.sha],
    ["editor solicitado", solicited(requested)],
    ["editor montado", `${mounted}${pm ? ` ${box(visual)}, editable=${pm.contentEditable}` : textarea ? ` ${box(textarea)}` : ""}`],
    ["preferencia almacenada", pref],
    ["query editor", `al abrir: ${editorDecision.query ?? "(ninguna)"} · ahora: ${new URLSearchParams(location.search).get("editor") ?? "(ninguna)"}`],
    ["storage disponible", storage()],
    ["ProseMirror", visualState.viewCreated ? `creado hace ${Math.round((Date.now() - visualState.viewCreated) / 1000)} s` : "no creado"],
    ["error del editor visual", visualState.error || "ninguno"],
    ["pantalla", `${innerWidth}×${innerHeight} @${devicePixelRatio}x · táctil: ${navigator.maxTouchPoints > 0 ? "sí" : "no"}`],
    ["user-agent", navigator.userAgent],
  ];
}

export default function EditorDiag({ requested }: { requested: boolean }) {
  const [rows, setRows] = useState<[string, string][]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const update = () => setRows(read(requested));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [requested]);
  if (!rows.length) return null;
  return (
    <aside className="editor-diag-bar" role="status" aria-label="Diagnóstico del editor (temporal)" data-requested={requested ? "visual" : "texto"}>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        Diagnóstico (temporal) {open ? "▾" : "▸"}
      </button>
      {open && (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k} data-key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}

/**
 * TEMPORARY: if the visual editor throws, say so on screen (with the message) instead of
 * taking the whole page down. It never falls back to the plain editor: a fallback would hide
 * exactly what we need to see.
 */
export class VisualEditorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    visualState.error = msg;
    return { error: msg };
  }
  render() {
    if (this.state.error) return <p className="editor-diag-error">El editor visual falló al montarse: {this.state.error}</p>;
    return this.props.children;
  }
}
