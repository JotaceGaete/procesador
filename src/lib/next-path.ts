/**
 * Where to go after logging in: the page the author was opening (src/proxy.ts passes it as
 * ?next=, with its own query such as ?editor=visual), only if it is a path of this app.
 * Anything else (another site, //host, \\host, control characters, /login itself) goes to
 * the library.
 */
export function safeNext(next: string | null): string {
  if (!next || !/^\/(?![/\\])/.test(next) || next.startsWith("/login") || /[\u0000-\u001f\u007f]/.test(next)) return "/";
  return next;
}
