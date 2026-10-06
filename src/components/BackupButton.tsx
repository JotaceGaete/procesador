"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { backupName, backupTexts, imagePath, type BackupData } from "@/lib/backup";
import { zip, type ZipEntry } from "@/lib/zip";

/**
 * Copia de seguridad (docs/versiones.md): the novel's data from the server, and each
 * original image file through its own short-lived link, in one ZIP built in the browser.
 */
export default function BackupButton({ novelId }: { novelId: string }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setStatus("Preparando la copia…");
    try {
      const data = await api<BackupData>(`/api/novels/${novelId}/backup`);
      const encoder = new TextEncoder();
      const entries: ZipEntry[] = backupTexts(data).map((f) => ({ name: f.name, data: encoder.encode(f.text) }));
      const missing: string[] = [];
      for (const [i, file] of data.images.files.entries()) {
        setStatus(`Imágenes originales: ${i + 1} de ${data.images.files.length}…`);
        try {
          const res = await fetch(`/api/assets/${file.id}/original?v=${file.version}`);
          if (!res.ok) throw new Error(String(res.status));
          entries.push({ name: imagePath(file), data: new Uint8Array(await res.arrayBuffer()) });
        } catch {
          missing.push(file.file_name || file.id);
        }
      }
      if (missing.length)
        entries.push({ name: "IMAGENES-QUE-FALTAN.txt", data: encoder.encode(`No se pudieron descargar:\n${missing.join("\n")}\n`) });
      const url = URL.createObjectURL(new Blob(zip(entries) as BlobPart[], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = backupName(data);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus(
        missing.length
          ? `Copia descargada, pero faltan ${missing.length === 1 ? "1 imagen" : `${missing.length} imágenes`} (la lista va dentro). Vuelve a intentarlo más tarde.`
          : "Copia descargada.",
      );
    } catch (e) {
      setStatus(`No se pudo hacer la copia: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backup">
      <button type="button" className="btn" onClick={download} disabled={busy}>
        Descargar copia de seguridad
      </button>
      <p className="muted small" role="status">
        {status ||
          "Un archivo .zip con la novela completa para leer, cada capítulo tal como está, la Memoria y los demás datos, y las imágenes originales."}
      </p>
    </div>
  );
}
