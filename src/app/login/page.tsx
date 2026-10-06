"use client";

import { useState } from "react";
import { safeNext } from "@/lib/next-path";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = safeNext(new URLSearchParams(window.location.search).get("next"));
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo entrar");
      setLoading(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>Procesador</h1>
        <label className="sr-only" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" disabled={loading || !password}>
          {loading ? "Entrando…" : "Entrar"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
