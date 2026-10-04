"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { readPref, writePref } from "@/lib/client";
import { useAutosave, type SaveState } from "./useAutosave";
import { blocks, countWords, imageAt, marker } from "@/lib/manuscript";

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
  insertAtCursor(text: string): boolean;
  /** The browser's own undo on the manuscript: the same history Ctrl/⌘+Z uses. */
  undo(): void;
  /** Collapses the selection to its end, so nothing is selected. */
  clearSelection(): void;
  /** Inserts image markers at the cursor, each in its own paragraph (undoable). */
  insertImages(ids: string[]): void;
  /** Inserts an image marker right after another one's paragraph (undoable). */
  insertImageAfter(existingId: string, id: string): void;
  /** Removes an image's marker from the text (undoable). The image itself stays, not placed. */
  removeImage(id: string): void;
  /** Puts the cursor on an image's marker (shows its card). */
  selectImage(id: string): boolean;
  /**
   * Selects a range and brings it into view (the Consejero's "Ir"). If the text moved
   * since the range was measured, the nearest occurrence of `expected` is selected.
   */
  selectRange(start: number, end: number, expected?: string): boolean;
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
  /** Cursor position after every move or edit, with the current text. */
  onCaret?(position: number, text: string): void;
  /** Image files pasted or dropped on the text. */
  onImageFiles?(files: File[]): void;
  /** Reading view: the text stays mounted (and keeps its undo history) but isn't shown. */
  hidden?: boolean;
}

const SAVE_POSITION_MS = 600;

/** One chapter's text. Remounted for each chapter (key = chapter id). */
const ChapterEditor = forwardRef<EditorHandle, Props>(function ChapterEditor(props, ref) {
  const { chapterId, initial, focusMode, onSelection, onStats, onSaveState, onCaret, onImageFiles, hidden } = props;
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
      () => onStats({ words: countWords(content), chars: content.length }),
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
    onCaret?.(end, el.value);
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
  }, [onSelection, onCaret]);

  /** Scrolls the textarea so a position is in view (a rough line height from the font size). */
  const reveal = useCallback((position: number) => {
    const el = textareaRef.current;
    if (!el) return;
    const lines = contentRef.current.slice(0, position).split("\n").length;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "28");
    const y = lines * lineHeight;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - lineHeight * 2) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, []);

  /**
   * insertText keeps the browser's undo history, so Ctrl/⌘+Z reverts it. `caret: "end"`
   * leaves the cursor right after the new text, ready to keep writing (the Asistente);
   * otherwise the new text stays selected (images, whose card follows the selection).
   */
  const replaceRange = useCallback(
    (start: number, end: number, text: string, caret: "select" | "end" = "select") => {
      const el = textareaRef.current!;
      el.focus();
      el.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, text)) {
        const current = contentRef.current;
        setContent(current.slice(0, start) + text + current.slice(end));
      }
      requestAnimationFrame(() => {
        if (caret === "end") {
          el.setSelectionRange(start + text.length, start + text.length);
          reveal(start + text.length);
        } else el.setSelectionRange(start, start + text.length);
        updateSelection();
      });
    },
    [updateSelection, reveal],
  );

  /** Inserts text as its own paragraphs at a position (blank lines around it, undoable). */
  const insertParagraphs = useCallback(
    (text: string, position: number, caret: "select" | "end" = "select") => {
      const current = contentRef.current;
      const at = Math.min(position, current.length);
      const before = current.slice(0, at);
      const after = current.slice(at);
      const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const tail = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
      // With the cursor at the end of the inserted text itself, not after the blank line that follows it.
      const inserted = `${lead}${text.trim()}`;
      replaceRange(at, at, `${inserted}${tail}`, caret);
      if (caret === "end" && tail) {
        requestAnimationFrame(() => {
          const el = textareaRef.current!;
          el.setSelectionRange(at + inserted.length, at + inserted.length);
          updateSelection();
        });
      }
    },
    [replaceRange, updateSelection],
  );
  const imageBlock = (id: string) =>
    blocks(contentRef.current).find((b) => b.kind === "image" && b.id === id) as { start: number; end: number } | undefined;

  const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

  // Typing on an image's line would turn its marker into plain text: the text starts a new
  // paragraph below the image instead. `beforeinput` sees every way of typing (keyboards,
  // phone keyboards, dictation), unlike keydown.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== "insertText" || !e.data || el.selectionStart !== el.selectionEnd) return;
      const img = imageAt(el.value, el.selectionStart);
      if (!img) return;
      e.preventDefault();
      el.setSelectionRange(img.end, img.end);
      // One undoable step: the new paragraph and what was typed.
      if (!document.execCommand("insertText", false, `\n\n${e.data}`)) {
        const v = el.value;
        setContent(`${v.slice(0, img.end)}\n\n${e.data}${v.slice(img.end)}`);
      }
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, []);

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
        replaceRange(start, start + original.text.length, rewrite, "end");
        return true;
      },
      insertAtCursor(text) {
        insertParagraphs(text, cursorRef.current, "end");
        return true;
      },
      undo() {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        document.execCommand("undo");
        updateSelection();
      },
      insertImages(ids) {
        if (!ids.length) return;
        // The textarea keeps its selection while something else has the focus (a panel, a button).
        insertParagraphs(ids.map(marker).join("\n\n"), textareaRef.current?.selectionEnd ?? cursorRef.current);
      },
      insertImageAfter(existingId, id) {
        const block = imageBlock(existingId);
        if (block) replaceRange(block.end, block.end, `\n\n${marker(id)}`);
        else insertParagraphs(marker(id), cursorRef.current);
      },
      removeImage(id) {
        const block = imageBlock(id);
        if (!block) return;
        const text = contentRef.current;
        // Take the line and one of the blank lines around it, so paragraphs stay tidy.
        let start = block.start;
        let end = block.end;
        if (text[end] === "\n") end++;
        if (text.slice(start - 2, start) === "\n\n") start--;
        else if (text[end] === "\n") end++;
        replaceRange(start, end, "");
      },
      selectImage(id) {
        const block = imageBlock(id);
        const el = textareaRef.current;
        if (!block || !el) return false;
        el.focus();
        el.setSelectionRange(block.start, block.start);
        // Bring it into view: a rough line height from the font size.
        const lines = contentRef.current.slice(0, block.start).split("\n").length;
        el.scrollTop = Math.max(0, lines * parseFloat(getComputedStyle(el).lineHeight || "28") - el.clientHeight / 3);
        updateSelection();
        return true;
      },
      selectRange(start, end, expected) {
        const el = textareaRef.current;
        if (!el) return false;
        const text = contentRef.current;
        if (expected && text.slice(start, end).toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
          const lower = text.toLocaleLowerCase();
          const needle = expected.toLocaleLowerCase();
          let best = -1;
          for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
            if (best === -1 || Math.abs(i - start) < Math.abs(best - start)) best = i;
          }
          if (best === -1) return false;
          start = best;
          end = best + expected.length;
        }
        if (end > text.length) return false;
        el.focus();
        el.setSelectionRange(start, end);
        const lines = text.slice(0, start).split("\n").length;
        el.scrollTop = Math.max(0, lines * parseFloat(getComputedStyle(el).lineHeight || "28") - el.clientHeight / 3);
        updateSelection();
        return true;
      },
      clearSelection() {
        const el = textareaRef.current;
        if (!el) return;
        el.setSelectionRange(el.selectionEnd, el.selectionEnd);
        updateSelection();
      },
    }),
    [flush, replaceRange, updateSelection, insertParagraphs],
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
      hidden={hidden}
      onPaste={(e) => {
        const files = imageFiles(e.clipboardData?.files);
        if (!files.length || !onImageFiles) return;
        e.preventDefault();
        onImageFiles(files);
      }}
      onDragOver={(e) => {
        if (onImageFiles && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer?.files);
        if (!files.length || !onImageFiles) return;
        e.preventDefault();
        onImageFiles(files);
      }}
      placeholder="Empieza a escribir…"
      spellCheck
      aria-label="Texto del capítulo"
    />
  );
});

export default ChapterEditor;
