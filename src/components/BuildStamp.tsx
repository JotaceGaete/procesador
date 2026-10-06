"use client";

import { useEffect, useState } from "react";
import { BUILD } from "@/lib/diag";

/**
 * Temporary (editor visual, Fase A): which editor is mounted, the editor saved on this device,
 * and whether this browser lets it be saved. Visible, so a phone can say what it runs.
 */
function editorDiag(): string {
  const mounted = document.querySelector(".visual-editor .visual-text") ? "visual" : document.querySelector("textarea.editor") ? "de texto" : "";
  let saved: string;
  try {
    const key = "procesador-diag-probe";
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
    saved = localStorage.getItem("editor") ?? "sin elegir";
  } catch {
    saved = "no se puede guardar en este navegador";
  }
  return `${mounted ? `editor ${mounted} · ` : ""}preferencia: ${saved}`;
}

/**
 * Temporary: which build this page is running, and whether the server already has another
 * (then this tab has old code until it is reloaded).
 */
export default function BuildStamp() {
  const [server, setServer] = useState<{ build?: string; deployment?: string | null } | null>(null);
  const [diag, setDiag] = useState("");
  useEffect(() => setDiag(editorDiag()), []);
  useEffect(() => {
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setServer)
      .catch(() => {});
  }, []);
  const when = BUILD.time ? new Date(BUILD.time).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "";
  const stale = server?.build && server.build !== BUILD.sha;
  return (
    <span className="build-stamp muted small" data-build={BUILD.sha} data-server-build={server?.build ?? ""}>
      Versión {BUILD.sha}
      {when && ` · ${when}`}
      {stale && <strong> · el servidor ya tiene {server!.build}: recarga la página</strong>}
      {diag && <span className="editor-diag"> · {diag}</span>}
    </span>
  );
}
