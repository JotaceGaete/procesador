"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { readPref, writePref } from "@/lib/client";
import { useAutosave, type SaveState } from "./useAutosave";

export interface Selection {
  start: number;
  end: number;
  text: string;
}

export interface EditorHandle {
  getContent(): string;
  getCursor(): number;
  /** Replaces the original fragment with the proposal (undoable with Ctrl/⌘+Z). */
  applyRewrite(original: Selection, rewrite: string): boolean;
  /** Inserts a scene at the cursor as its own paragraphs (undoable). */
  insertAtCursor(text: string): void;
  /** Saves and waits; true when nothing is left unsaved. */
  flush(): Promise<boolean>;
}

interface Props {
  chapterId: string;
  initial: { content: string; revision: number };
  focusMode: boolean;
  onSelection(sel: Selection | null): void;
  onStats(stats: { words: number; chars: number }): void;
  onSaveState(state: SaveState, actions: { retry(): void; overwrite(): void }): void;
}

const SAVE_POSITION_MS = 600;

/** One chapter's text. Remounted for each chapter (key = chapter id). */
const ChapterEditor = forwardRef<EditorHandle, Props>(function ChapterEditor(props, ref) {
  const { chapterId, initial, focusMode, onSelection, onStats, onSaveState } = props;
  const [content, setContent] = useState(initial.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  const cursorRef = useRef(0);
  contentRef.current = content;

  const autosave = useAutosave(`/api/chapters/${chapterId}`, content, initial);
  const { state, save, overwrite, flush } = autosave;

  useEffect(() => onSaveState(state, { retry: save, overwrite }), [state, save, overwrite, onSaveState]);

  // Counting words in a long chapter on every keystroke is noticeable: do it once typing pauses.
  const firstCount = useRef(true);
  useEffect(() => {
    const t = setTimeout(
      () => onStats({ words: (content.match(/\S+/g) ?? []).length, chars: content.length }),
      firstCount.current ? 0 : 400,
    );
    firstCount.current = false;
    return () => clearTimeout(t);
  }, [content, onStats]);

  // Restore where the author was in this chapter (cursor and scroll), per device.
  const positionKey = `pos:${chapterId}`;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let pos: { cursor?: number; scroll?: number } = {};
    try {
      pos = JSON.parse(readPref(positionKey) ?? "{}");
    } catch {}
    const cursor = Math.min(Math.max(0, Number(pos.cursor) || 0), el.value.length);
    el.focus({ preventScroll: true });
    el.setSelectionRange(cursor, cursor);
    cursorRef.current = cursor;
    el.scrollTop = Number(pos.scroll) || 0;
  }, [positionKey]);

  const savePosition = useCallback(() => {
    const el = textareaRef.current;
    if (el) writePref(positionKey, JSON.stringify({ cursor: el.selectionStart, scroll: Math.round(el.scrollTop) }));
  }, [positionKey]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const el = textareaRef.current;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(savePosition, SAVE_POSITION_MS);
    };
    el?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      el?.removeEventListener("scroll", onScroll);
      savePosition();
    };
  }, [savePosition]);

  const lastSel = useRef<Selection | null>(null);
  const updateSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    cursorRef.current = end;
    const prev = lastSel.current;
    const next =
      end > start
        ? prev && prev.start === start && prev.end === end
          ? prev
          : { start, end, text: el.value.slice(start, end) }
        : null;
    if (next !== prev) {
      lastSel.current = next;
      onSelection(next);
    }
  }, [onSelection]);

  /** insertText keeps the browser's undo history, so Ctrl/⌘+Z reverts it. */
  const replaceRange = useCallback(
    (start: number, end: number, text: string) => {
      const el = textareaRef.current!;
      el.focus();
      el.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, text)) {
        const current = contentRef.current;
        setContent(current.slice(0, start) + text + current.slice(end));
      }
      requestAnimationFrame(() => {
        el.setSelectionRange(start, start + text.length);
        updateSelection();
      });
    },
    [updateSelection],
  );

  useImperativeHandle(
    ref,
    () => ({
      getContent: () => contentRef.current,
      getCursor: () => cursorRef.current,
      flush,
      applyRewrite(original, rewrite) {
        const current = contentRef.current;
        let start = original.start;
        if (current.slice(start, original.end) !== original.text) {
          // The text moved since the request: take the occurrence closest to where it was.
          let best = -1;
          for (let i = current.indexOf(original.text); i !== -1; i = current.indexOf(original.text, i + 1)) {
            if (best === -1 || Math.abs(i - original.start) < Math.abs(best - original.start)) best = i;
          }
          if (best === -1) return false;
          start = best;
        }
        replaceRange(start, start + original.text.length, rewrite);
        return true;
      },
      insertAtCursor(text) {
        const current = contentRef.current;
        const at = Math.min(cursorRef.current, current.length);
        const before = current.slice(0, at);
        const after = current.slice(at);
        const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const tail = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
        replaceRange(at, at, `${lead}${text.trim()}${tail}`);
      },
    }),
    [flush, replaceRange],
  );

  return (
    <textarea
      ref={textareaRef}
      className={`editor${focusMode ? " focused" : ""}`}
      value={content}
      onChange={(e) => {
        setContent(e.target.value);
        updateSelection();
      }}
      onSelect={updateSelection}
      onMouseUp={updateSelection}
      onKeyUp={updateSelection}
      onBlur={savePosition}
      placeholder="Empieza a escribir…"
      spellCheck
      aria-label="Texto del capítulo"
    />
  );
});

export default ChapterEditor;
