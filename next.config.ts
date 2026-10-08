import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// Which code the browser is running (temporary diagnostic: shown discreetly in the app).
function commit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "local";
  }
}

const nextConfig: NextConfig = {
  // Pages are never kept by the browser's cache: after locking, Back can't show them again
  // (docs/privacidad.md). Their data comes from the API, which answers no-store too.
  async headers() {
    return ["/", "/novela/:path*"].map((source) => ({ source, headers: [{ key: "Cache-Control", value: "no-store" }] }));
  },
  env: {
    NEXT_PUBLIC_BUILD_SHA: commit().slice(0, 7),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_BUILD_DEPLOYMENT: process.env.VERCEL_DEPLOYMENT_ID ?? "",
  },
};

export default nextConfig;
