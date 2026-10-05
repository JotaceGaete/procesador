"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";

export type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;
// Browsers cap keepalive request bodies at 64 KB; longer texts rely on the unload warning.
const KEEPALIVE_LIMIT = 60_000;

/**
 * Saves one chapter's `content` a moment after typing stops. Only one save is
 * in flight at a time; each save sends the revision it is based on, so a newer
 * save from another tab or device is never silently overwritten ("conflict").
 *
 * The component using it is remounted per chapter, so `endpoint` never changes
 * under a running save.
 */
export function useAutosave(endpoint: string, content: string, initial: { content: string; revision: number }) {
  const [state, setState] = useState<SaveState>("saved");
  const contentRef = useRef(content);
  const savedRef = useRef(initial.content);
  const revisionRef = useRef(initial.revision);
  const inFlight = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  contentRef.current = content;

  const save = useCallback(
    (opts: { keepalive?: boolean } = {}): Promise<void> => {
      const text = contentRef.current;
      if (text === savedRef.current || blocked.current) return Promise.resolve();
      if (inFlight.current) return inFlight.current; // the running save re-checks when it finishes
      setState("saving");
      const run = (async () => {
        try {
          const body = JSON.stringify({ content: text, revision: revisionRef.current });
          const res = await api<{ revision: number }>(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: Boolean(opts.keepalive) && body.length < KEEPALIVE_LIMIT,
          });
          revisionRef.current = res.revision;
          savedRef.current = text;
          setState(contentRef.current === text ? "saved" : "pending");
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            blocked.current = true;
            setState("conflict");
          } else {
            setState("error");
          }
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = run;
      return run;
    },
    [endpoint],
  );

  // Debounce while typing; after a failed save keep retrying every few seconds.
  useEffect(() => {
    if (content === savedRef.current || blocked.current) return;
    if (state === "saved") setState("pending");
    const t = setTimeout(save, state === "error" ? RETRY_MS : DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [content, state, save]);

  // A save that finished while more text arrived.
  useEffect(() => {
    if (state === "pending" && !inFlight.current) {
      const t = setTimeout(save, DEBOUNCE_MS);
      return () => clearTimeout(t);
    }
  }, [state, save]);

  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && save({ keepalive: true });
    const onUnload = (e: BeforeUnloadEvent) => {
      if (contentRef.current !== savedRef.current) {
        save({ keepalive: true });
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [save]);

  /**
   * Keep our text: the other tab's or device's text is kept first as a version (if that
   * fails, nothing is overwritten), then ours is saved over the server's latest revision.
   */
  const overwrite = useCallback(async () => {
    try {
      await api(`${endpoint}/versions`, { method: "POST", json: { reason: "conflict" } });
    } catch {
      setState("conflict");
      return;
    }
    const chapter = await api<{ revision: number }>(endpoint);
    revisionRef.current = chapter.revision;
    blocked.current = false;
    await save();
  }, [endpoint, save]);

  /**
   * Saves now and waits. Resolves true only when everything is on the server
   * (used before switching chapter or leaving the novel).
   */
  const flush = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 3; i++) {
      if (inFlight.current) await inFlight.current;
      if (blocked.current) return false;
      if (contentRef.current === savedRef.current) return true;
      await save();
    }
    return contentRef.current === savedRef.current && !blocked.current;
  }, [save]);

  return { state, save, overwrite, flush };
}
