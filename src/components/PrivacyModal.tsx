"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { APP_IDLE_OPTIONS } from "@/lib/privacy";
import Modal from "./Modal";

/** Procesador's own lock: how long without activity before it asks for its password again. */
export default function PrivacyModal({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ appIdleMinutes: number }>("/api/settings")
      .then((s) => setMinutes(s.appIdleMinutes))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save(value: number) {
    setBusy(true);
    setError("");
    try {
      const s = await api<{ appIdleMinutes: number }>("/api/settings", { method: "PATCH", json: { appIdleMinutes: value } });
      setMinutes(s.appIdleMinutes);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Privacidad" onClose={onClose}>
      <div className="form">
        <label className="short">
          <span>Bloquear Procesador tras</span>
          <select
            value={minutes ?? ""}
            disabled={minutes === null || busy}
            onChange={(e) => void save(Number(e.target.value))}
            aria-label="Minutos sin actividad antes de bloquear Procesador"
          >
            {APP_IDLE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutos` : `${m / 60} ${m === 60 ? "hora" : "horas"}`} sin actividad
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Al bloquearse, Procesador guarda lo que estabas escribiendo, cierra lo que tenías abierto y pide su contraseña. También
          puedes bloquearlo cuando quieras con «Bloquear» o con Ctrl/⌘+Shift+L. Un minuto antes avisa, por si sólo estabas
          leyendo.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}
