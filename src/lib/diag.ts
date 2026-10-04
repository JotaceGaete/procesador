"use client";

/**
 * Temporary diagnostic mode: open any page with ?diag=1 (stays on in this browser until
 * ?diag=0). It shows the Asistente's internal state and, when a text is tapped, which
 * state it comes from (the nearest data-origin).
 */
export const BUILD = {
  sha: process.env.NEXT_PUBLIC_BUILD_SHA ?? "?",
  time: process.env.NEXT_PUBLIC_BUILD_TIME ?? "",
  deployment: process.env.NEXT_PUBLIC_BUILD_DEPLOYMENT ?? "",
};

export function diagEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("diag");
    if (q === "1") localStorage.setItem("diag", "1");
    if (q === "0") localStorage.removeItem("diag");
    return localStorage.getItem("diag") === "1";
  } catch {
    return false;
  }
}
