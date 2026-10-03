import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  // Clear-Site-Data also drops cached private images.
  const res = NextResponse.json({ ok: true }, { headers: { "Clear-Site-Data": '"cache"' } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
