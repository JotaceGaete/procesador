import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import { getCharacterImages } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string }> };

/** Makes this the character's main image (the previous one stops being it, in one transaction). */
export const POST = novelHandler<Ctx>(byChild("character_images"), async (_request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const { data, error } = await db().from("character_images").select("character_id").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Imagen no encontrada");
  const { error: rpcError } = await db().rpc("set_primary_image", { p_image: id });
  if (rpcError) throw rpcError;
  return NextResponse.json(await getCharacterImages(data.character_id));
});
