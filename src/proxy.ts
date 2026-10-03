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
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login$|api/login$|_next/static|_next/image|favicon.ico).*)"],
};
