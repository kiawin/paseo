import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { CsvTextPatch } from "./edit";
import type { CsvHeaderMode } from "./parse";

type ResolvedHeaderMode = Exclude<CsvHeaderMode, "auto">;

export interface CsvEditSessionState {
  headerMode: CsvHeaderMode;
  /** The grid's edits, oldest first. Each one reverts the text the edit after it started from. */
  undo: readonly CsvTextPatch[];
  /** The buffer the grid last produced. The undo patches apply to this text and no other. */
  lastText: string | null;
}

export type CsvEditSessionAction =
  | { type: "setHeaderMode"; mode: ResolvedHeaderMode }
  | {
      type: "committed";
      before: string;
      text: string;
      patch: CsvTextPatch;
      /** How the grid read the first row when the edit was made. */
      headerMode: ResolvedHeaderMode;
    }
  | { type: "undone"; text: string };

export interface CsvEditSession {
  state: CsvEditSessionState;
  dispatch: Dispatch<CsvEditSessionAction>;
}

export function createCsvEditSessionState(): CsvEditSessionState {
  return { headerMode: "auto", undo: [], lastText: null };
}

export function csvEditSessionReducer(
  state: CsvEditSessionState,
  action: CsvEditSessionAction,
): CsvEditSessionState {
  if (action.type === "setHeaderMode") return { ...state, headerMode: action.mode };
  if (action.type === "undone") {
    return { ...state, undo: state.undo.slice(0, -1), lastText: action.text };
  }
  const earlier = action.before === state.lastText ? state.undo : [];
  // An edit to one of the first two rows can flip header inference and shift every row by one.
  const headerMode = state.headerMode === "auto" ? action.headerMode : state.headerMode;
  return { headerMode, undo: [...earlier, action.patch], lastText: action.text };
}

/** The patch that undoes the latest edit, while `content` is still the text that edit produced. */
export function undoableCsvPatch(state: CsvEditSessionState, content: string): CsvTextPatch | null {
  if (content !== state.lastText) return null;
  return state.undo.at(-1) ?? null;
}

const CsvEditSessionContext = createContext<CsvEditSession | null>(null);

/**
 * Holds what must outlive the grid: the text panel unmounts its Preview while Source is shown, and
 * undo and the header mode have to be there when the user comes back.
 */
export function CsvEditSessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(csvEditSessionReducer, undefined, createCsvEditSessionState);
  const session = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <CsvEditSessionContext.Provider value={session}>{children}</CsvEditSessionContext.Provider>
  );
}

/** The panel's session, or one of the grid's own when nothing provides it. */
export function useCsvEditSession(): CsvEditSession {
  const provided = useContext(CsvEditSessionContext);
  const [state, dispatch] = useReducer(csvEditSessionReducer, undefined, createCsvEditSessionState);
  const own = useMemo(() => ({ state, dispatch }), [state]);
  return provided ?? own;
}
