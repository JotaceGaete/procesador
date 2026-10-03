import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import { bucket } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string; variant: string }> };

const notFound = () => new HttpError(404, "Imagen no encontrada");

/**
 * Serves a file of the novel: `thumb` and `display` (the interface's derivatives)
 * or `original` (as uploaded, for download and export).
 *
 * Cache (docs/archivos.md): the URL carries the version, and every request is
 * checked against the current row first, so a deleted file or an old version is
 * a 404. Browsers keep a copy for 10 minutes at most, then revalidate with the
 * ETag (304 without touching Storage while unchanged).
 */
export const GET = handler<Ctx>(async (request, { params }) => {
  const { id: rawId, variant } = await params;
  const id = assertId(rawId, "Imagen");
  if (!["thumb", "display", "original"].includes(variant)) throw notFound();
  const { data, error } = await db()
    .from("assets")
    .select("status, version, file_name, original_path, display_path, thumb_path, original_type, derived_type")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const v = new URL(request.url).searchParams.get("v");
  if (!data || data.status !== "ready" || v !== String(data.version)) throw notFound();

  if (variant === "original") {
    // Originals can exceed what a function may return: a short-lived signed link, never cached.
    const name = data.file_name || `original.${data.original_path.split(".").pop()}`;
    const { data: signed, error: signError } = await bucket().createSignedUrl(data.original_path, 60, { download: name });
    if (signError || !signed) throw notFound();
    return NextResponse.redirect(signed.signedUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
  }

  const etag = `"${id}-v${data.version}-${variant}"`;
  const headers = { "Cache-Control": "private, max-age=600, must-revalidate", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const { data: file, error: fileError } = await bucket().download(variant === "display" ? data.display_path : data.thumb_path);
  if (fileError || !file) throw notFound();
  return new NextResponse(file.stream(), {
    headers: { ...headers, "Content-Type": data.derived_type, "X-Content-Type-Options": "nosniff" },
  });
});
