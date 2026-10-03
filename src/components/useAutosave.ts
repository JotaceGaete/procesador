"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";

export type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;
// Browsers cap keepalive request bodies at 64 KB; longer texts rely on the unload warning.
const KEEPALIVE_LIMIT = 60_000;

/**
 * Saves `content` a moment after typing stops. Only one save is in flight at a
 * time; each save sends the revision it is based on, so a newer save from
 * another tab or device is never silently overwritten (state "conflict").
 */
export function useAutosave(content: string, initial: { content: string; revision: number } | null) {
  const [state, setState] = useState<SaveState>("saved");
  const contentRef = useRef(content);
  const savedRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  contentRef.current = content;

  useEffect(() => {
    if (initial && savedRef.current === null) {
      savedRef.current = initial.content;
      revisionRef.current = initial.revision;
    }
  }, [initial]);

  const save = useCallback(async (opts: { keepalive?: boolean } = {}) => {
    const text = contentRef.current;
    if (savedRef.current === null || text === savedRef.current || blocked.current) return;
    if (inFlight.current) return; // the running save re-checks when it finishes
    inFlight.current = true;
    setState("saving");
    try {
      const body = JSON.stringify({ content: text, revision: revisionRef.current });
      const res = await api<{ revision: number }>("/api/project", {
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
      inFlight.current = false;
    }
  }, []);

  // Debounce while typing; after a failed save keep retrying every few seconds.
  useEffect(() => {
    if (savedRef.current === null || content === savedRef.current || blocked.current) return;
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
      if (savedRef.current !== null && contentRef.current !== savedRef.current) {
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

  /** Keep our text: adopt the server's latest revision and save over it. */
  const overwrite = useCallback(async () => {
    const { project } = await api<{ project: { revision: number } }>("/api/project");
    revisionRef.current = project.revision;
    blocked.current = false;
    await save();
  }, [save]);

  return { state, save, overwrite };
}
