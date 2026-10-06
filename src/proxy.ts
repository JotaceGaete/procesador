import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, checkSession } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const state = await checkSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (state === "ok") return NextResponse.next();

  if (state === "misconfigured") {
    return new NextResponse("Falta configurar APP_PASSWORD en el servidor.", { status: 503 });
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  // Back to where the author was going after logging in (with its query: ?editor=visual).
  const login = new URL("/login", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  // The icons and the manifest are public: the login page shows them, and browsers fetch the
  // manifest without cookies (docs/icono.md).
  matcher: ["/((?!login$|api/login$|_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$|icons/).*)"],
};
