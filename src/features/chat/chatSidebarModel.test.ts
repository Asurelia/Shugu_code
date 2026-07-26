import { describe, expect, it } from "vitest";
import {
  findConversation,
  flattenConversations,
  groupConversationsByActivity,
  nextUnreadConversationId,
  patchConversationTree,
  removeConversationTree,
  type SidebarConversation,
} from "./chatSidebarModel";

const conversation = (
  id: string,
  updated: number,
  extra: Partial<SidebarConversation> = {},
): SidebarConversation => ({ id, updated, ...extra });

describe("groupConversationsByActivity", () => {
  it("uses local calendar days and keeps pinned conversations separate", () => {
    const now = new Date(2026, 6, 26, 12).getTime();
    const groups = groupConversationsByActivity(
      [
        conversation("pinned", now - 10 * 86_400_000, { pinned: true }),
        conversation("today", new Date(2026, 6, 26, 1).getTime()),
        conversation("yesterday", new Date(2026, 6, 25, 23).getTime()),
        conversation("older", new Date(2026, 6, 24, 23).getTime()),
      ],
      now,
    );

    expect(groups.map(({ id }) => id)).toEqual([
      "pinned",
      "today",
      "yesterday",
      "older",
    ]);
    expect(groups.map(({ items }) => items.map(({ id }) => id))).toEqual([
      ["pinned"],
      ["today"],
      ["yesterday"],
      ["older"],
    ]);
  });

  it("counts unread descendants in the group badge", () => {
    const now = new Date(2026, 6, 26, 12).getTime();
    const groups = groupConversationsByActivity(
      [
        conversation("parent", now, {
          unread: true,
          children: [conversation("child", now, { unread: true })],
        }),
      ],
      now,
    );
    expect(groups[0].unreadCount).toBe(2);
  });
});

describe("conversation tree helpers", () => {
  const tree = [
    conversation("a", 1, {
      children: [conversation("a-child", 2, { unread: true })],
    }),
    conversation("b", 3, { unread: true }),
  ];

  it("flattens, finds and patches descendants", () => {
    expect(flattenConversations(tree).map(({ id }) => id)).toEqual([
      "a",
      "a-child",
      "b",
    ]);
    expect(findConversation(tree, "a-child")?.unread).toBe(true);
    expect(
      findConversation(
        patchConversationTree(tree, "a-child", { unread: false }),
        "a-child",
      )?.unread,
    ).toBe(false);
    expect(
      findConversation(removeConversationTree(tree, "a-child"), "a-child"),
    ).toBeUndefined();
  });

  it("navigates unread conversations in both directions with wraparound", () => {
    expect(nextUnreadConversationId(tree, "a", 1)).toBe("a-child");
    expect(nextUnreadConversationId(tree, "a-child", 1)).toBe("b");
    expect(nextUnreadConversationId(tree, "a-child", -1)).toBe("b");
    expect(nextUnreadConversationId(tree, "b", 1)).toBe("a-child");
  });
});
