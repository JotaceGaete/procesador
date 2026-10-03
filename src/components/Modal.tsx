"use client";

import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  wide?: boolean;
  children: React.ReactNode;
}

export default function Modal({ title, onClose, onBack, wide, children }: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {onBack && (
            <button className="link" onClick={onBack} aria-label="Volver">
              ←
            </button>
          )}
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="link" onClick={onClose} aria-label="Cerrar">
            Cerrar
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
