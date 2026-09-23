import type { NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { EditorVisualTheme } from "@/file-panels/source/editor/extensions.web";
import type { NoteEditorModel } from "./model";
import type { NoteView } from "./view-mode";

export interface NoteEditorViewProps {
  model: NoteEditorModel;
  note: NoteRecordPayload | null;
  view: NoteView;
  onViewChange: (view: NoteView) => void;
  body: string;
  imageBehavior: "auto" | "tap-to-load" | "disabled";
  remoteImageLoadLabel: string;
  theme: EditorVisualTheme;
  deleting: boolean;
  deleteError: string | null;
  onDelete?: () => void;
  onRetry?: () => void;
}
