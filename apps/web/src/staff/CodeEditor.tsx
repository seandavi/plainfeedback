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
  /** Inserts text at the cursor (on its own lines) and focuses the editor. */
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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
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
      const { from, to } = v.state.selection.main;
      const before = from > 0 && v.state.sliceDoc(from - 1, from) !== "\n" ? "\n\n" : "";
      const insert = `${before}${text}\n`;
      v.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
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
