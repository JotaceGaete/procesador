import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { conversationWithMessages, getConversation } from "@/lib/advisor/conversations";

type Ctx = { params: Promise<{ id: string }> };

/** A conversation with its messages and their observations (each with what changed since). */
export const GET = novelHandler<Ctx>(byChild("advisor_conversations"), async (_request, { params }) =>
  NextResponse.json(await conversationWithMessages((await params).id), { headers: { "Cache-Control": "no-store" } }),
);

export const PATCH = novelHandler<Ctx>(byChild("advisor_conversations"), async (request, { params }) => {
  const c = await getConversation((await params).id);
  const body = await readJson(request);
  if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "La conversación necesita un título.");
  const { error } = await db().from("advisor_conversations").update({ title: body.title.trim().slice(0, 200) }).eq("id", c.id);
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});

/** Deletes the conversation. Observations the author saved stay (without their message). */
export const DELETE = novelHandler<Ctx>(byChild("advisor_conversations"), async (_request, { params }) => {
  const c = await getConversation((await params).id);
  const { data: msgs, error: e1 } = await db().from("advisor_messages").select("id").eq("conversation_id", c.id);
  if (e1) throw e1;
  if (msgs.length) {
    const { error: e2 } = await db()
      .from("advisor_observations")
      .delete()
      .in("message_id", msgs.map((m) => m.id))
      .neq("status", "saved");
    if (e2) throw e2;
  }
  const { error } = await db().from("advisor_conversations").delete().eq("id", c.id);
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
