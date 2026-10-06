"use client";

/**
 * Editor visual, Fase A (docs/editor-visual.md): the chapter as the book shows it, edited in
 * place. Paragraphs with Lectura's typography, real italics, images with their caption and
 * credit, scene breaks as an ornament; never `*`, `[[imagen:…]]` or `[[separador]]`.
 *
 * Same contract as ChapterEditor (EditorHandle, offsets in `content`), so the Asistente, the
 * Consejero, versions and images work unchanged. `content` stays the source of truth: the
 * document is built from it and written back in the same format (src/lib/visual/document.ts),
 * byte for byte where the author didn't type.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EditorState, NodeSelection, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { gapCursor } from "prosemirror-gapcursor";
import { readPref, writePref } from "@/lib/client";
import { countWords } from "@/lib/manuscript";
import { findQuote } from "@/lib/advisor/quotes";
import { placeAtEnd } from "@/lib/placement";
import { assetUrl } from "@/lib/images";
import { fragmentFromText, layout, offsetToPos, posToOffset, schema, toContent, toDoc } from "@/lib/visual/document";
import type { ManuscriptImage } from "@/lib/types";
import { useAutosave, type SaveState } from "./useAutosave";
import { pendingLabel, type Pending } from "./ManuscriptImages";
import type { EditorHandle, Selection } from "./ChapterEditor";

interface Props {
  chapterId: string;
  initial: { content: string; revision: number };
  focusMode: boolean;
  onSelection(sel: Selection | null): void;
  onStats(stats: { words: number; chars: number }): void;
  onSaveState(state: SaveState, actions: { retry(): void; overwrite(): void }): void;
  onCaret?(position: number, text: string): void;
  onImageFiles?(files: File[]): void;
  hidden?: boolean;
  /** The chapter's number and own title, as the book opens it. */
  heading?: { number: string; title: string };
  images: ManuscriptImage[];
  pending: Pending;
}

/** How long typing may run before `content` (autosave, word count, the image card) catches up. */
const SYNC_MS = 120;
const SAVE_POSITION_MS = 600;

// ---------------------------------------------------------------------------
// Images: drawn from manuscript_images (caption, credit, alt text, size), as in Lectura.
// ---------------------------------------------------------------------------

interface ImageStore {
  images: Map<string, ManuscriptImage>;
  pending: Pending;
  listeners: Set<() => void>;
}

class ImageView implements NodeView {
  dom: HTMLElement;
  private id: string;
  private off: () => void;
  constructor(
    node: PMNode,
    private store: ImageStore,
  ) {
    this.id = node.attrs.id;
    this.dom = document.createElement("figure");
    const render = () => this.render();
    store.listeners.add(render);
    this.off = () => store.listeners.delete(render);
    this.render();
  }
  private render() {
    const img = this.store.images.get(this.id);
    const dom = this.dom;
    dom.replaceChildren();
    dom.dataset.imageId = this.id;
    dom.removeAttribute("style");
    if (!img) {
      const p = this.store.pending[this.id];
      dom.className = "fig missing";
      const span = document.createElement("span");
      span.textContent = p ? `${p.name}: ${pendingLabel(p)}` : "Imagen no encontrada";
      dom.append(span);
      return;
    }
    dom.className = `fig layout-${img.layout} align-${img.align}`;
    dom.style.width = `${img.layout === "page" ? 100 : img.width_pct}%`;
    const el = document.createElement("img");
    el.src = assetUrl(img.asset, "display");
    el.alt = img.decorative ? "" : img.alt;
    el.width = img.asset.width;
    el.height = img.asset.height;
    el.decoding = "async";
    el.draggable = false;
    dom.append(el);
    if (img.caption || img.credit) {
      const cap = document.createElement("figcaption");
      if (img.caption) {
        const c = document.createElement("span");
        c.className = "fig-caption";
        c.textContent = img.caption;
        cap.append(c);
      }
      if (img.credit) {
        const c = document.createElement("span");
        c.className = "fig-credit";
        c.textContent = img.credit;
        cap.append(c);
      }
      dom.append(cap);
    }
  }
  update(node: PMNode) {
    return node.type === schema.nodes.image && node.attrs.id === this.id;
  }
  ignoreMutation() {
    return true;
  }
  destroy() {
    this.off();
  }
}

/** The empty chapter's invitation to write. */
const placeholder = new Plugin({
  props: {
    decorations(state) {
      const doc = state.doc;
      if (doc.childCount !== 1 || doc.firstChild!.type !== schema.nodes.paragraph || doc.firstChild!.content.size) return null;
      return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize, { class: "is-empty", "data-placeholder": "Empieza a escribir…" })]);
    },
  },
});

/** Clipboard as prose: paragraphs, `* * *` between scenes, no markers. */
function proseOf(slice: Slice): string {
  const out: string[] = [];
  slice.content.forEach((n) => {
    if (n.type === schema.nodes.scene_break) out.push("* * *");
    else if (n.isTextblock) out.push(n.textContent);
    else if (n.isText) out.push(n.text ?? "");
  });
  return out.join(slice.content.firstChild?.isInline ? "" : "\n\n");
}

/** Text inserted as its own paragraphs at an offset (blank lines around it), as ChapterEditor does. */
function withParagraphs(content: string, position: number, text: string) {
  const at = Math.min(position, content.length);
  const before = content.slice(0, at);
  const after = content.slice(at);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const inserted = `${lead}${text.trim()}`;
  return { text: `${before}${inserted}${tail}${after}`, start: at, end: at + inserted.length };
}

const VisualEditor = forwardRef<EditorHandle, Props>(function VisualEditor(props, ref) {
  const { chapterId, initial, focusMode, onSelection, onStats, onSaveState, onCaret, onImageFiles, hidden, heading, images, pending } = props;
  const [content, setContent] = useState(initial.content);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const store = useMemo<ImageStore>(() => ({ images: new Map(), pending: {}, listeners: new Set() }), []);
  const callbacks = useRef({ onSelection, onCaret, onImageFiles });
  callbacks.current = { onSelection, onCaret, onImageFiles };

  const autosave = useAutosave(`/api/chapters/${chapterId}`, content, initial);
  const { state, save, overwrite, flush: flushSave } = autosave;
  useEffect(() => onSaveState(state, { retry: save, overwrite }), [state, save, overwrite, onSaveState]);

  const firstCount = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => onStats({ words: countWords(content), chars: content.length }), firstCount.current ? 0 : 400);
    firstCount.current = false;
    return () => clearTimeout(t);
  }, [content, onStats]);

  useEffect(() => {
    store.images = new Map(images.map((i) => [i.id, i]));
    store.pending = pending;
    store.listeners.forEach((l) => l());
  }, [images, pending, store]);

  const doc = () => viewRef.current!.state.doc;
  const getContent = useCallback(() => (viewRef.current ? toContent(viewRef.current.state.doc) : initial.content), [initial.content]);

  /** `content`, the image card and the Asistente's selection, a moment after the last change. */
  const lastSel = useRef<Selection | null>(null);
  const report = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const d = view.state.doc;
    const text = toContent(d);
    setContent(text);
    const sel = view.state.selection;
    let next: Selection | null = null;
    let caret: number;
    if (sel instanceof NodeSelection) caret = posToOffset(d, sel.from, "start");
    else if (sel.empty) caret = posToOffset(d, sel.head);
    else {
      const start = posToOffset(d, sel.from, "start");
      const end = posToOffset(d, sel.to, "end");
      caret = end;
      if (end > start) next = { start, end, text: text.slice(start, end) };
    }
    callbacks.current.onCaret?.(caret, text);
    const prev = lastSel.current;
    if (!(prev === next || (prev && next && prev.start === next.start && prev.end === next.end))) {
      lastSel.current = next;
      callbacks.current.onSelection(next);
    }
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(report, SYNC_MS);
  }, [report]);

  // Where the author was in this chapter (shared with the plain editor: offsets in the text).
  const positionKey = `pos:${chapterId}`;
  const savePosition = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    writePref(positionKey, JSON.stringify({ cursor: posToOffset(view.state.doc, view.state.selection.head), scroll: Math.round(scrollRef.current?.scrollTop ?? 0) }));
  }, [positionKey]);

  useEffect(() => {
    const swallow = () => true;
    // Enter never stacks empty paragraphs (they would open space that Lectura and the book don't
    // have): not in an empty paragraph, nor at the start of one that follows an empty paragraph.
    // Space between scenes comes from a scene break.
    const enter = (s: EditorState) => {
      const { $from, empty } = s.selection;
      if (!empty || $from.parent.type !== schema.nodes.paragraph) return false;
      if ($from.parent.content.size === 0) return true;
      const before = $from.parentOffset === 0 ? s.doc.resolve($from.before()).nodeBefore : null;
      return !!before && before.type === schema.nodes.paragraph && before.content.size === 0;
    };
    const view = new EditorView(mountRef.current!, {
      state: EditorState.create({
        doc: toDoc(initial.content),
        plugins: [
          history(),
          keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo, "Mod-i": toggleMark(schema.marks.italic), "Mod-b": swallow, "Mod-u": swallow, Enter: enter }),
          keymap(baseKeymap),
          gapCursor(),
          placeholder,
        ],
      }),
      nodeViews: { image: (node) => new ImageView(node, store) },
      attributes: { class: "visual-text", spellcheck: "true", "aria-label": "Texto del capítulo", "aria-multiline": "true", role: "textbox" },
      // Typing with an image or a scene break selected never replaces it (as in the plain editor,
      // where typing on a marker's line starts a new paragraph): the text goes in a new paragraph
      // after it. Deleting a block is explicit: Backspace or Delete (and undoable).
      handleTextInput: (v, _from, _to, text) => {
        const sel = v.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.isTextblock) return false;
        const pos = sel.to;
        const tr = v.state.tr.insert(pos, schema.nodes.paragraph.create(null, schema.text(text)));
        v.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1 + text.length)).scrollIntoView());
        return true;
      },
      // Pasted text in the manuscript format: its paragraphs, italics and blocks. A line break at
      // its start (or end) starts (or ends) a paragraph, as in any editor; otherwise the first
      // and last lines join the paragraph where it is pasted.
      clipboardTextParser: (text) => {
        // Pasted text is new content: its blocks take the chapter's spacing, not the clipboard's.
        const pasted: PMNode[] = [];
        fragmentFromText(text).forEach((n) => pasted.push(n.type.create({ ...n.attrs, before: null }, n.content, n.marks)));
        let frag = Fragment.from(pasted);
        // An empty, open paragraph on that side closes the one where the text lands.
        if (/^[^\S\n]*\r?\n/.test(text)) frag = Fragment.from(schema.nodes.paragraph.create()).append(frag);
        if (/\r?\n[^\S\n]*$/.test(text)) frag = frag.append(Fragment.from(schema.nodes.paragraph.create()));
        return new Slice(frag, frag.firstChild?.isTextblock ? 1 : 0, frag.lastChild?.isTextblock ? 1 : 0);
      },
      clipboardTextSerializer: proseOf,
      handlePaste: (_v, e) => {
        const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (!files.length || !callbacks.current.onImageFiles) return false;
        callbacks.current.onImageFiles(files);
        return true;
      },
      handleDrop: (_v, e) => {
        const files = [...((e as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (!files.length || !callbacks.current.onImageFiles) return false;
        callbacks.current.onImageFiles(files);
        return true;
      },
      dispatchTransaction(tr: Transaction) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged || tr.selectionSet) schedule();
      },
    });
    viewRef.current = view;
    let pos: { cursor?: number; scroll?: number } = {};
    try {
      pos = JSON.parse(readPref(positionKey) ?? "{}");
    } catch {}
    const at = offsetToPos(view.state.doc, Math.max(0, Number(pos.cursor) || 0));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
    view.focus();
    if (scrollRef.current) scrollRef.current.scrollTop = Number(pos.scroll) || 0;
    report();
    const onBlur = () => savePosition();
    view.dom.addEventListener("blur", onBlur);
    return () => {
      view.dom.removeEventListener("blur", onBlur);
      if (timer.current) clearTimeout(timer.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one view per chapter (remounted by key)
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(savePosition, SAVE_POSITION_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener("scroll", onScroll);
      savePosition();
    };
  }, [savePosition]);

  /** Selects offsets of the text: a block's whole line selects the block (an image shows its card). */
  const selectOffsets = useCallback((tr: Transaction, start: number, end: number) => {
    const d = tr.doc;
    if (start !== end) {
      const b = layout(d).blocks.find((x) => !x.node.isTextblock && x.lineStart === start && x.lineStart + x.line.length === end);
      if (b) return tr.setSelection(NodeSelection.create(d, b.pos));
      return tr.setSelection(TextSelection.between(d.resolve(offsetToPos(d, start)), d.resolve(offsetToPos(d, end))));
    }
    return tr.setSelection(TextSelection.near(d.resolve(offsetToPos(d, start))));
  }, []);

  /**
   * A change made on the text (the Asistente, restoring a version): the document becomes that
   * text, replacing only the blocks that differ, as one undoable step.
   */
  const applyContent = useCallback(
    (next: string, select: [number, number]) => {
      const view = viewRef.current;
      if (!view) return false;
      const target = toDoc(next);
      const current = view.state.doc;
      let tr = view.state.tr;
      const start = current.content.findDiffStart(target.content);
      if (start !== null) {
        let { a, b } = current.content.findDiffEnd(target.content)!;
        const overlap = start - Math.min(a, b);
        if (overlap > 0) {
          a += overlap;
          b += overlap;
        }
        tr.replace(start, a, target.slice(start, b));
      }
      for (const attr of ["trail", "gap"]) if (tr.doc.attrs[attr] !== target.attrs[attr]) tr.setDocAttribute(attr, target.attrs[attr]);
      if (toContent(tr.doc) !== next) {
        // Never expected (the blocks that stay are the same lines); if it happens, the whole text.
        tr = view.state.tr.replaceWith(0, current.content.size, target.content);
        for (const attr of ["trail", "gap"]) tr.setDocAttribute(attr, target.attrs[attr]);
      }
      selectOffsets(tr, ...select);
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    },
    [selectOffsets],
  );

  const findImage = (id: string): { pos: number; node: PMNode } | null => {
    let found: { pos: number; node: PMNode } | null = null;
    doc().forEach((node, pos) => {
      if (!found && node.type === schema.nodes.image && node.attrs.id === id) found = { pos, node };
    });
    return found;
  };

  /** Inserts blocks at the selection; the cursor goes after them (a new paragraph if none follows). */
  const insertBlocks = useCallback((nodes: PMNode[], selectFirst: boolean) => {
    const view = viewRef.current;
    if (!view || !nodes.length) return;
    const tr = view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0));
    const after = tr.selection.$to;
    if (selectFirst) {
      // The inserted nodes are these same objects: select the first one (its card shows).
      let at = -1;
      tr.doc.forEach((n, p) => {
        if (at === -1 && n === nodes[0]) at = p;
      });
      if (at !== -1) tr.setSelection(NodeSelection.create(tr.doc, at));
    } else if (!after.parent.isTextblock) {
      const pos = after.pos;
      const next = tr.doc.resolve(pos).nodeAfter;
      if (!next || !next.isTextblock) tr.insert(pos, schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getContent,
      getCursor: () => (viewRef.current ? posToOffset(doc(), viewRef.current.state.selection.head) : 0),
      async flush() {
        if (timer.current) clearTimeout(timer.current);
        // The autosave reads `content` as rendered: bring it up to date now.
        flushSync(() => setContent(getContent()));
        return flushSave();
      },
      applyRewrite(original, rewrite) {
        const current = getContent();
        let start = original.start;
        if (current.slice(start, original.end) !== original.text) {
          let best = -1;
          for (let i = current.indexOf(original.text); i !== -1; i = current.indexOf(original.text, i + 1)) {
            if (best === -1 || Math.abs(i - original.start) < Math.abs(best - original.start)) best = i;
          }
          if (best === -1) return false;
          start = best;
        }
        const end = start + original.text.length;
        const at = start + rewrite.length;
        return applyContent(current.slice(0, start) + rewrite + current.slice(end), [at, at]);
      },
      insertAtCursor(text) {
        if (!viewRef.current) return false;
        const r = withParagraphs(getContent(), posToOffset(doc(), viewRef.current.state.selection.head), text);
        return applyContent(r.text, [r.end, r.end]);
      },
      insertAt(position, text) {
        const r = withParagraphs(getContent(), position, text);
        return applyContent(r.text, [r.end, r.end]);
      },
      insertAtEnd(text) {
        const current = getContent();
        const place = placeAtEnd(current, text);
        const at = place.start + place.text.length;
        return applyContent(current.slice(0, place.start) + place.text + current.slice(place.end), [at, at]);
      },
      undo() {
        const view = viewRef.current;
        if (!view) return;
        undo(view.state, view.dispatch);
        view.focus();
      },
      clearSelection() {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.selection.$to)));
      },
      insertImages(ids) {
        insertBlocks(
          ids.map((id) => schema.nodes.image.create({ id })),
          true,
        );
      },
      insertImageAfter(existingId, id) {
        const view = viewRef.current;
        const at = findImage(existingId);
        if (!view) return;
        if (!at) return insertBlocks([schema.nodes.image.create({ id })], true);
        const pos = at.pos + at.node.nodeSize;
        const tr = view.state.tr.insert(pos, schema.nodes.image.create({ id }));
        view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView());
      },
      removeImage(id) {
        const view = viewRef.current;
        const at = findImage(id);
        if (!view || !at) return;
        view.dispatch(view.state.tr.delete(at.pos, at.pos + at.node.nodeSize));
      },
      toggleItalic() {
        const view = viewRef.current;
        if (!view) return;
        toggleMark(schema.marks.italic)(view.state, view.dispatch);
        view.focus();
      },
      insertSeparator() {
        insertBlocks([schema.nodes.scene_break.create()], false);
      },
      replaceAll(text) {
        if (!applyContent(text, [0, 0])) return;
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      },
      selectImage(id) {
        const view = viewRef.current;
        const at = findImage(id);
        if (!view || !at) return false;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos)).scrollIntoView());
        view.focus();
        return true;
      },
      selectRange(start, end, expected) {
        const view = viewRef.current;
        if (!view) return false;
        const text = getContent();
        if (expected && text.slice(start, end).toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
          let found = findQuote(text, expected, start);
          if (!found) {
            const lower = text.toLocaleLowerCase();
            const needle = expected.toLocaleLowerCase();
            for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
              if (!found || Math.abs(i - start) < Math.abs(found.start - start)) found = { start: i, end: i + expected.length };
            }
          }
          if (!found) return false;
          ({ start, end } = found);
        }
        if (end > text.length) return false;
        view.dispatch(selectOffsets(view.state.tr, start, end).scrollIntoView());
        view.focus();
        return true;
      },
    }),
    [getContent, flushSave, applyContent, insertBlocks, selectOffsets],
  );

  return (
    <div ref={scrollRef} className={`reading visual-editor${focusMode ? " focused" : ""}`} hidden={hidden} data-editor="visual">
      {heading && (
        <header className="reading-chapter" contentEditable={false}>
          <div className="reading-number">{heading.number}</div>
          {heading.title && <h2>{heading.title}</h2>}
        </header>
      )}
      <div ref={mountRef} />
    </div>
  );
});

export default VisualEditor;
