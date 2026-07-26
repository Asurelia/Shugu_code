import { Fragment, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "@/lib/types";

export const TRANSCRIPT_VIRTUALIZE_AFTER = 80;

export function shouldVirtualizeTranscript(messageCount: number): boolean {
  return messageCount >= TRANSCRIPT_VIRTUALIZE_AFTER;
}

export function TranscriptMessageList({
  messages,
  scrollRef,
  renderMessage,
}: {
  messages: Message[];
  scrollRef: RefObject<HTMLDivElement>;
  renderMessage: (message: Message, index: number) => ReactNode;
}) {
  const virtualized = shouldVirtualizeTranscript(messages.length);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    getItemKey: (index) => String(messages[index]?.id ?? index),
    overscan: 6,
    gap: 22,
    enabled: virtualized,
  });

  if (!virtualized) {
    return (
      <>
        {messages.map((message, index) => (
          <Fragment key={String(message.id)}>
            {renderMessage(message, index)}
          </Fragment>
        ))}
      </>
    );
  }

  return (
    <div
      className="cx-virtual-list"
      data-virtualized="true"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const message = messages[item.index];
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="cx-virtual-row"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {renderMessage(message, item.index)}
          </div>
        );
      })}
    </div>
  );
}
