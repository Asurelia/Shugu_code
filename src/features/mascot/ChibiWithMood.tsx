// Shugu Forge — ChibiWithMood (chat-flavored chibi anchor).
//
// Default anchor for the mascot's FloatShell when paired with ChatPanel. Wires
// the chibi PNG to the mood derivation by reading:
//   - edge from useFloatShell() (geometry — peek_open / peek_closed)
//   - busy from useChatBusy() (chat is generating — joy)
//   - hasKey from useDiscoveredModels (provider configured — !cry)
//   - hasUnread from useChatUnread() (new AI message while tucked)
//   - hasMessages from useMessages() (something to be smiley about)
//   - pinnedAnno from props (chat hand-off, currently inactive in mascot.tsx)
//
// Tomorrow a TaskWithMood (or any other panel-flavored anchor) can mirror
// this wiring but pull from task/agent stores instead — the shell stays the
// same, the mood derivation comes from whatever stores the active panel
// writes to.
//
// Alt+click on the chibi cycles through manual mood overrides. We intercept
// the click in capture phase + stopPropagation so the shell's avatar-button
// onClick (toggle closed/compact) doesn't also fire.

import { useChibiMood } from "@/features/mascot/useChibiMood";
import { Chibi } from "@/features/mascot/Chibi";
import { useFloatShell } from "@/features/floating/FloatShell";
import { useActiveConv, useMessages } from "@/features/chat/chat-sync";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { useChatBusy } from "@/features/chat/chatBusy";
import { useChatUnread } from "@/features/chat/chatUnread";

export interface ChibiWithMoodProps {
  /** Pinned annotation passed from the host (currently null in mascot.tsx). */
  pinnedAnno?: unknown;
  /** Chibi PNG render size. Defaults to 240, matching the float-avatar-flip slot. */
  size?: number;
}

export function ChibiWithMood({ pinnedAnno = null, size = 240 }: ChibiWithMoodProps) {
  const { edge } = useFloatShell();
  const [activeConv] = useActiveConv();
  const { data: msgs } = useMessages(activeConv);
  const { data: discoveredModels } = useDiscoveredModels();
  const busy = useChatBusy();
  const hasUnread = useChatUnread();

  const { mood, cycleMood } = useChibiMood({
    edge,
    hasUnread,
    busy,
    hasKey: discoveredModels.length > 0,
    pinnedAnno,
    hasMessages: msgs.length > 0,
  });

  // Intercept alt+click in capture phase so the FloatShell avatar-button's
  // onClick (mode toggle) doesn't also fire.
  const onClickCapture = (e: React.MouseEvent) => {
    if (e.altKey) {
      e.stopPropagation();
      cycleMood();
    }
  };

  return (
    <span onClickCapture={onClickCapture}>
      <Chibi size={size} mood={mood} />
    </span>
  );
}
