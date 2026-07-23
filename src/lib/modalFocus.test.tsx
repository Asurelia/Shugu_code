import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/trust/ConfirmDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  document.body.querySelectorAll(".trust-confirm-overlay").forEach((node) => node.remove());
});

async function flushFocus(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("modal focus contract", () => {
  it("traps Tab, handles Escape and restores the launcher focus", async () => {
    const launcher = document.createElement("button");
    document.body.appendChild(launcher);
    launcher.focus();
    const onCancel = vi.fn();

    act(() => {
      root.render(
        <ConfirmDialog
          open
          title="Supprimer ?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />,
      );
    });
    await flushFocus();

    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    const buttons = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button"));
    expect(document.activeElement).toBe(buttons[1]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();

    act(() => {
      root.render(
        <ConfirmDialog
          open={false}
          title="Supprimer ?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />,
      );
    });
    await flushFocus();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });
});
