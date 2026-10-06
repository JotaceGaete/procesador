"use client";

import { useEffect, useState } from "react";
import { BUILD } from "@/lib/diag";

/**
 * Temporary: which build this page is running, and whether the server already has another
 * (then this tab has old code until it is reloaded).
 */
export default function BuildStamp() {
  const [server, setServer] = useState<{ build?: string; deployment?: string | null } | null>(null);
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
    </span>
  );
}
