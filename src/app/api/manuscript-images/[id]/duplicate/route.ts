import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import { getManuscriptImage } from "@/lib/assets-server";
import { applyUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

/** Another image of the book with the same file (reused, not copied) and the same texts and layout, not placed yet. */
export const POST = novelHandler<Ctx>(byChild("manuscript_images"), async (_request, { params }) => {
  const source = await getManuscriptImage(assertId((await params).id, "Imagen"));
  if (!source) throw new HttpError(404, "Imagen no encontrada");
  const { alt, decorative, caption, credit, layout, align, width_pct } = source;
  const { manuscriptImage } = await applyUse(
    { kind: "manuscript", alt, decorative, caption, credit, layout, align, width_pct },
    source.asset_id,
    source.novel_id,
  );
  return NextResponse.json(manuscriptImage, { status: 201 });
});
