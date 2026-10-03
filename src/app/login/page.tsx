"use client";

import { useState } from "react";

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
      window.location.href = "/";
    } else {
      setError("Contraseña incorrecta");
      setLoading(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>Procesador</h1>
        <input
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
