import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Temporary diagnostic: the code the server is running right now, to compare with the one
 * compiled into the page the browser has open (an old tab keeps its old JavaScript).
 */
export function GET() {
  return NextResponse.json(
    {
      build: process.env.NEXT_PUBLIC_BUILD_SHA,
      builtAt: process.env.NEXT_PUBLIC_BUILD_TIME,
      deployment: process.env.VERCEL_DEPLOYMENT_ID || process.env.NEXT_PUBLIC_BUILD_DEPLOYMENT || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
