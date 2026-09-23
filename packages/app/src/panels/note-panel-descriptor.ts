import type { NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { ComponentType } from "react";

import type { PanelDescriptor, PanelIconProps } from "./panel-registry";

export function buildNotePanelDescriptor(input: {
  record: Pick<NoteRecordPayload, "displayTitle"> | null;
  fallbackLabel: string;
  subtitle: string;
  tooltip: string;
  icon: ComponentType<PanelIconProps>;
}): PanelDescriptor {
  const label = input.record?.displayTitle ?? input.fallbackLabel;
  return {
    label,
    subtitle: input.subtitle,
    tooltip: input.record?.displayTitle ?? input.tooltip,
    titleState: input.record ? "ready" : "loading",
    icon: input.icon,
    statusBucket: null,
  };
}
