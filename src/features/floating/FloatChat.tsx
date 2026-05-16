// Shugu Forge — FloatChat (backwards-compat thin wrapper).
//
// Phase 5 split the original 500-line FloatChat into FloatShell (generic
// coque) + ChibiWithMood (chat-flavored anchor) + ChatPanel (chat-specific
// body content). This wrapper preserves the original `<FloatChat .../>`
// API for any caller that hasn't migrated to the compound pattern yet.
//
// New code should compose directly:
//
//     <FloatShell anchor={<ChibiWithMood/>}>
//       <ChatPanel />
//     </FloatShell>
//
// That's exactly what mascot.tsx does — and that's what makes swapping
// <ChatPanel/> for any other panel possible without touching the shell.

import { FloatShell } from "@/features/floating/FloatShell";
import { ChibiWithMood } from "@/features/mascot/ChibiWithMood";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { type FloatEdge } from "@/features/floating/useFloatPosition";

export interface FloatChatProps {
  pinnedAnno?: any;
  clearPinned?: () => void;
  disableInternalDrag?: boolean;
  forceSide?: "left" | "right";
  freezePos?: boolean;
  forceEdge?: FloatEdge | undefined;
}

export function FloatChat({
  pinnedAnno,
  clearPinned,
  disableInternalDrag,
  forceSide,
  freezePos,
  forceEdge,
}: FloatChatProps) {
  return (
    <FloatShell
      anchor={<ChibiWithMood pinnedAnno={pinnedAnno} />}
      disableInternalDrag={disableInternalDrag}
      forceSide={forceSide}
      freezePos={freezePos}
      forceEdge={forceEdge}
    >
      <ChatPanel pinnedAnno={pinnedAnno} clearPinned={clearPinned} />
    </FloatShell>
  );
}
