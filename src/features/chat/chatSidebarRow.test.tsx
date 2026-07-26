import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRow } from "./chat-sidebar";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ChatRow conversation tree", () => {
  it("activates and exposes the actual child conversation", () => {
    const onPick = vi.fn();
    const onCtx = vi.fn();

    act(() => {
      root.render(
        <ChatRow
          convo={{
            id: "parent",
            title: "Parent",
            children: [
              {
                id: "child",
                title: "Child",
                unread: true,
              },
            ],
          }}
          activeId="child"
          renamingId={null}
          onPick={onPick}
          onCtx={onCtx}
          onRename={() => {}}
          onCancelRename={() => {}}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          dragging={false}
          dragEnabled={false}
          onHover={() => {}}
        />,
      );
    });

    const child = host.querySelector<HTMLElement>(".chat-row.child");
    expect(child?.classList.contains("active")).toBe(true);
    expect(child?.classList.contains("unread")).toBe(true);

    act(() => {
      child?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith("child");

    act(() => {
      child?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(onCtx.mock.calls[0]?.[1]?.id).toBe("child");
  });
});
