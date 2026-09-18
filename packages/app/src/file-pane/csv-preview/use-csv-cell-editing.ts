import { useCallback, useRef, useState } from "react";
import type { TextFilePreviewEditor } from "@/file-panels/source/panel";
import {
  CSV_EDIT_MAX_BYTES,
  applyCsvCellEdit,
  revertCsvTextPatch,
  type CsvCellEditRejection,
} from "./edit";
import { undoableCsvPatch, type CsvEditSession } from "./edit-session";
import { parseCsv, type CsvHeaderResolution, type ParsedCsv } from "./parse";

/**
 * One cell opened for editing. Everything is captured when the sheet opens and never re-derived,
 * so a change to the file while the user types neither replaces the draft nor moves its target.
 */
export interface CsvCellDraft {
  /** Counts opens, so each one mounts a fresh editor. */
  key: number;
  /** The buffer the draft was opened on, and its parse. */
  text: string;
  parsed: ParsedCsv;
  /** Index into `parsed.rows`, so a header row counts. */
  record: number;
  column: number;
  firstRowIsHeader: boolean;
  value: string;
  columnName: string;
  rowNumber: number;
  rowValues: readonly string[];
  focusOnOpen: boolean;
}

export interface CsvDraftCell {
  rowIndex: number;
  column: number;
  focusOnOpen: boolean;
}

/** `stale`: the file changed after the draft was opened. */
export type CsvDraftSaveError = CsvCellEditRejection | "stale";

/** An edit the grid made itself, with the parse it already has for the new text. */
export interface CsvOwnEdit {
  text: string;
  parsed: ParsedCsv;
}

export interface CsvCellEditing {
  draft: CsvCellDraft | null;
  isDraftStale: boolean;
  openDraft(cell: CsvDraftCell): void;
  closeDraft(): void;
  /** Applies the draft to the buffer. Null when it was applied or nothing changed. */
  saveDraft(value: string): CsvDraftSaveError | null;
  canUndo: boolean;
  undo(): void;
}

export function useCsvCellEditing(input: {
  editor: TextFilePreviewEditor | undefined;
  session: CsvEditSession;
  filePath: string;
  content: string;
  /** The text `parsed` was read from; it trails `content` while a parse is pending. */
  parseContent: string;
  parsed: ParsedCsv | null;
  header: CsvHeaderResolution | null;
  onOwnEdit(edit: CsvOwnEdit): void;
}): CsvCellEditing {
  const { editor, filePath, content, parseContent, parsed, header, onOwnEdit } = input;
  const { state: sessionState, dispatch } = input.session;
  const [draft, setDraft] = useState<CsvCellDraft | null>(null);
  const openCount = useRef(0);
  // The editor object changes with every save state. Opening a cell depends only on having one,
  // so the grid's press handlers stay the same while a save runs.
  const hasEditor = editor !== undefined;

  const openDraft = useCallback(
    (cell: CsvDraftCell) => {
      const isParseCurrent = content === parseContent;
      if (!hasEditor || !parsed || !header || !isParseCurrent) {
        setDraft(null);
        return;
      }
      const rowValues = header.bodyRows[cell.rowIndex];
      const value = rowValues?.[cell.column];
      if (parsed.unterminatedQuote || !rowValues || value === undefined) {
        setDraft(null);
        return;
      }
      openCount.current += 1;
      const headerRows = header.hasHeader ? 1 : 0;
      setDraft({
        key: openCount.current,
        text: content,
        parsed,
        record: cell.rowIndex + headerRows,
        column: cell.column,
        firstRowIsHeader: header.hasHeader,
        value,
        columnName: header.headers[cell.column] ?? `Column ${cell.column + 1}`,
        rowNumber: cell.rowIndex + headerRows + 1,
        rowValues,
        focusOnOpen: cell.focusOnOpen,
      });
    },
    [content, hasEditor, header, parseContent, parsed],
  );

  const closeDraft = useCallback(() => setDraft(null), []);

  const saveDraft = useCallback(
    (value: string): CsvDraftSaveError | null => {
      if (!draft || !editor || content !== draft.text) return "stale";
      const result = applyCsvCellEdit({
        text: draft.text,
        parsed: draft.parsed,
        filePath,
        record: draft.record,
        column: draft.column,
        value,
        maxBytes: CSV_EDIT_MAX_BYTES,
      });
      if (result.status === "rejected") return result.reason;
      if (result.status === "applied") {
        editor.edit(result.text);
        dispatch({
          type: "committed",
          before: draft.text,
          text: result.text,
          patch: result.patch,
          headerMode: draft.firstRowIsHeader ? "header" : "data",
        });
        onOwnEdit({ text: result.text, parsed: result.parsed });
      }
      setDraft(null);
      return null;
    },
    [content, dispatch, draft, editor, filePath, onOwnEdit],
  );

  const undoPatch = editor ? undoableCsvPatch(sessionState, content) : null;
  const undo = useCallback(() => {
    if (!editor || !undoPatch) return;
    const text = revertCsvTextPatch(content, undoPatch);
    editor.edit(text);
    dispatch({ type: "undone", text });
    onOwnEdit({ text, parsed: parseCsv(text, { filePath }) });
  }, [content, dispatch, editor, filePath, onOwnEdit, undoPatch]);

  return {
    draft,
    isDraftStale: draft !== null && content !== draft.text,
    openDraft,
    closeDraft,
    saveDraft,
    canUndo: undoPatch !== null,
    undo,
  };
}
