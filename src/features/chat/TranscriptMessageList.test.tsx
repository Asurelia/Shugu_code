import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { enabled: boolean }) => ({
    getTotalSize: () => 12_000,
    getVirtualItems: () =>
      options.enabled
        ? [
            { index: 40, key: "m-40", start: 8_000 },
            { index: 41, key: "m-41", start: 8_220 },
          ]
        : [],
    measureElement: () => {},
  }),
}));

import {
  shouldVirtualizeTranscript,
  TranscriptMessageList,
} from "./TranscriptMessageList";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const messages = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "ai" : "user",
    text: `Message ${index}`,
  }));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TranscriptMessageList", () => {
  it("keeps short conversations in the normal document flow", () => {
    act(() => {
      root.render(
        <TranscriptMessageList
          messages={messages(3)}
          scrollRef={createRef<HTMLDivElement>()}
          renderMessage={(message) => (
            <span data-message-id={message.id}>{message.text}</span>
          )}
        />,
      );
    });
    expect(host.querySelector("[data-virtualized]")).toBeNull();
    expect(host.querySelectorAll("[data-message-id]")).toHaveLength(3);
  });

  it("mounts only the measured window for a long conversation", () => {
    act(() => {
      root.render(
        <TranscriptMessageList
          messages={messages(100)}
          scrollRef={createRef<HTMLDivElement>()}
          renderMessage={(message) => (
            <span data-message-id={message.id}>{message.text}</span>
          )}
        />,
      );
    });
    expect(shouldVirtualizeTranscript(79)).toBe(false);
    expect(shouldVirtualizeTranscript(80)).toBe(true);
    expect(host.querySelector("[data-virtualized='true']")).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll("[data-message-id]")).map((node) =>
        node.getAttribute("data-message-id"),
      ),
    ).toEqual(["m-40", "m-41"]);
  });
});
