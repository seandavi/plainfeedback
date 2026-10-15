// CodeMirror 6 markdown editor (bundled; no CDN). Controlled: `value` from outside replaces the
// document (e.g. reload after a conflict). Compile errors arrive as `diagnostics` (1-based lines).
// No indentWithTab, so Tab still moves focus out of the editor (keyboard users are not trapped).
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorSelection, EditorState, type Text } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { CompileError } from "@plainfeedback/core";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

export type CodeEditorHandle = {
  /** Inserts a question block near the cursor (see insertPosition) and focuses the editor. */
  insert: (text: string) => void;
  /** Moves the cursor to a 1-based line and focuses the editor. */
  goToLine: (line: number) => void;
};
export type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  diagnostics: CompileError[];
  readOnly?: boolean;
  label: string;
  ref?: Ref<CodeEditorHandle>;
};

const lineAt = (doc: Text, n: number) => doc.line(Math.min(Math.max(1, n), doc.lines));

const FENCE = /^\s*:{3,}\s*(.*?)\s*$/;

/** Where a new question block goes for a cursor offset: never in the title and intro (end of the
 * document), never inside a block (after its closing ':::'), otherwise after the cursor's line.
 * A never-focused editor has its cursor at 0, in the title, so it lands at the end. */
export function insertPosition(doc: string, cursor: number): number {
  let from = 0;
  let inBlock = false;
  let seen = false; // a question block has started
  let found = false; // the cursor is in a block: insert after its closing line
  for (const line of doc.split("\n")) {
    const to = from + line.length;
    const fence = line.match(FENCE)?.[1];
    if (fence === "" && inBlock) {
      inBlock = false;
      if (found) return to;
    } else if (fence && !inBlock) {
      inBlock = true;
      seen = true;
    }
    if (!found && cursor <= to) {
      if (inBlock) found = true;
      else return seen ? to : doc.length;
    }
    from = to + 1;
  }
  return doc.length;
}

/** The text to insert so `snippet` becomes its own paragraph, where, and the cursor after it. */
export function insertSnippet(doc: string, cursor: number, snippet: string) {
  const at = insertPosition(doc, cursor);
  const before =
    at === 0 || doc.slice(at - 2, at) === "\n\n" ? "" : doc[at - 1] === "\n" ? "\n" : "\n\n";
  const insert = `${before}${snippet}\n`;
  return { at, insert, cursor: at + insert.length };
}

export function toDiagnostics(doc: Text, errors: CompileError[]): Diagnostic[] {
  return errors.map((e) => {
    const line = lineAt(doc, e.line); // "never closed" errors may point past the end
    const from = e.column ? Math.min(line.from + e.column - 1, line.to) : line.from;
    return { from, to: line.to, severity: "error", message: `Line ${e.line}: ${e.message}` };
  });
}

const theme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)", height: "100%" },
  ".cm-content": {
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontVariantLigatures: "none", // "ffi" must read as three letters
    caretColor: "var(--fg)",
  },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--panel)" },
  "&.cm-focused": { outline: "3px solid var(--accent)" },
  // drawSelection() paints its own caret and selection, so caretColor alone leaves the base
  // theme's black caret and light selection in dark mode. The focused selector must match the base
  // theme's specificity to win.
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--selection)" },
  ".cm-tooltip": {
    color: "var(--fg)",
    backgroundColor: "var(--panel)",
    border: "1px solid var(--line)",
  },
});

export function CodeEditor({
  value,
  onChange,
  diagnostics,
  readOnly,
  label,
  ref,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const ro = useRef(new Compartment());

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; props sync below
  useEffect(() => {
    const v = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          lintGutter(),
          theme,
          ro.current.of(EditorState.readOnly.of(!!readOnly)),
          // tabindex: axe does not count contenteditable alone as focusable content of the scroller.
          EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: ro.current.reconfigure(EditorState.readOnly.of(!!readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toDiagnostics(v.state.doc, diagnostics)));
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const v = view.current;
      if (!v) return;
      const doc = v.state.doc.toString();
      const { at, insert, cursor } = insertSnippet(doc, v.state.selection.main.head, text);
      v.dispatch({
        changes: { from: at, insert },
        selection: EditorSelection.cursor(cursor),
        scrollIntoView: true,
      });
      v.focus();
    },
    goToLine(n) {
      const v = view.current;
      if (!v) return;
      v.dispatch({ selection: { anchor: lineAt(v.state.doc, n).from }, scrollIntoView: true });
      v.focus();
    },
  }));

  return <div ref={host} className="code" />;
}
