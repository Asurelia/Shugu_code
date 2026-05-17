// Shugu Forge — TanStack queryKey factory for the chat feature.

export const chatKeys = {
  all: ["chat"] as const,

  /** Messages (par conversation). */
  messages: () => [...chatKeys.all, "messages"] as const,
  messagesByConv: (convId: string) =>
    [...chatKeys.messages(), convId] as const,

  /** Conversations (liste). */
  conversations: () => [...chatKeys.all, "conversations"] as const,

  /** Active conversation id (synthetic global state). */
  activeConv: () => [...chatKeys.all, "active-conv"] as const,
  /** Active model id (synthetic global state). */
  activeModel: () => [...chatKeys.all, "active-model"] as const,
};
