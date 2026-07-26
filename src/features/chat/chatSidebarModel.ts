export interface SidebarConversation {
  id: string;
  updated: number;
  pinned?: boolean;
  unread?: boolean;
  children?: SidebarConversation[];
}

export interface ActivityConversationGroup<T> {
  id: "pinned" | "today" | "yesterday" | "older";
  label: string;
  pinnedSection?: boolean;
  items: T[];
  unreadCount: number;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function flattenConversations<T extends SidebarConversation>(
  conversations: T[],
): T[] {
  const flat: T[] = [];
  const visit = (items: T[]) => {
    for (const item of items) {
      flat.push(item);
      if (item.children?.length) visit(item.children as T[]);
    }
  };
  visit(conversations);
  return flat;
}

export function findConversation<T extends SidebarConversation>(
  conversations: T[],
  id: string,
): T | undefined {
  return flattenConversations(conversations).find(
    (conversation) => conversation.id === id,
  );
}

export function patchConversationTree<T extends SidebarConversation>(
  conversations: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  return conversations.map((conversation) => {
    const children = conversation.children?.length
      ? patchConversationTree(conversation.children as T[], id, patch)
      : conversation.children;
    if (conversation.id === id) {
      return { ...conversation, ...patch, children } as T;
    }
    if (children !== conversation.children) {
      return { ...conversation, children } as T;
    }
    return conversation;
  });
}

export function removeConversationTree<T extends SidebarConversation>(
  conversations: T[],
  id: string,
): T[] {
  return conversations
    .filter((conversation) => conversation.id !== id)
    .map((conversation) => {
      if (!conversation.children?.length) return conversation;
      const children = removeConversationTree(conversation.children as T[], id);
      return children === conversation.children
        ? conversation
        : ({ ...conversation, children } as T);
    });
}

export function groupConversationsByActivity<T extends SidebarConversation>(
  conversations: T[],
  now = Date.now(),
): ActivityConversationGroup<T>[] {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = startOfLocalDay(todayStart - 1);
  const groups: ActivityConversationGroup<T>[] = [
    {
      id: "pinned",
      label: "Épinglées",
      pinnedSection: true,
      items: [],
      unreadCount: 0,
    },
    {
      id: "today",
      label: "Aujourd’hui",
      items: [],
      unreadCount: 0,
    },
    {
      id: "yesterday",
      label: "Hier",
      items: [],
      unreadCount: 0,
    },
    {
      id: "older",
      label: "Plus ancien",
      items: [],
      unreadCount: 0,
    },
  ];

  for (const conversation of conversations) {
    const group = conversation.pinned
      ? groups[0]
      : conversation.updated >= todayStart
        ? groups[1]
        : conversation.updated >= yesterdayStart
          ? groups[2]
          : groups[3];
    group.items.push(conversation);
    group.unreadCount += flattenConversations([conversation]).filter(
      (item) => item.unread,
    ).length;
  }

  return groups.filter((group) => group.items.length > 0);
}

export function nextUnreadConversationId<T extends SidebarConversation>(
  conversations: T[],
  activeId: string,
  direction: 1 | -1,
): string | null {
  const flat = flattenConversations(conversations);
  if (flat.length === 0) return null;

  const unread = new Set(
    flat.filter((conversation) => conversation.unread).map(({ id }) => id),
  );
  if (unread.size === 0) return null;

  const activeIndex = flat.findIndex(
    (conversation) => conversation.id === activeId,
  );
  const origin =
    activeIndex >= 0 ? activeIndex : direction === 1 ? -1 : flat.length;

  for (let distance = 1; distance <= flat.length; distance += 1) {
    const index = (origin + direction * distance + flat.length) % flat.length;
    if (unread.has(flat[index].id)) return flat[index].id;
  }
  return null;
}
