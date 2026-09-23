import type { NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { EditorVisualTheme } from "@/file-pane/editor/extensions.web";
import type { NoteEditorModel } from "./model";

export interface NoteEditorViewProps {
  model: NoteEditorModel;
  note: NoteRecordPayload | null;
  body: string;
  imageBehavior: "auto" | "tap-to-load" | "disabled";
  remoteImageLoadLabel: string;
  theme: EditorVisualTheme;
  deleting: boolean;
  deleteError: string | null;
  onDelete?: () => void;
  onRetry?: () => void;
}
