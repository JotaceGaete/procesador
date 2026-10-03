// Runs in both the Node runtime and the proxy, so it only uses Web Crypto.
export const SESSION_COOKIE = "procesador_session";

export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`procesador:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function authEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

export async function isValidSession(cookie: string | undefined): Promise<boolean> {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  if (!cookie) return false;
  return cookie === (await sessionToken(password));
}
