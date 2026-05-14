import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  conversations: defineTable({
    title: v.string(),
    projectId: v.optional(v.id("projects")),
    pinned: v.boolean(),
    archived: v.boolean(),
    unread: v.boolean(),
    updatedAt: v.number(),
    parentId: v.optional(v.id("conversations")), // sub-conversations
    env: v.optional(v.union(v.literal("dev"), v.literal("prod"))),
  })
    .index("by_project", ["projectId"])
    .index("by_updated", ["updatedAt"])
    .index("by_parent",  ["parentId"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("ai"), v.literal("system")),
    text: v.optional(v.string()),
    body: v.optional(v.string()),
    code: v.optional(v.object({ lang: v.string(), text: v.string() })),
    image: v.optional(v.boolean()),
    ts: v.number(),
  }).index("by_conv", ["conversationId"]),

  projects: defineTable({  // = "groups" in the prototype
    name: v.string(),
    color: v.optional(v.string()),
    order: v.number(),
  }),

  imageJobs: defineTable({
    prompt: v.string(),
    negative: v.optional(v.string()),
    ratio: v.string(),
    model: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    resultUrl: v.optional(v.string()),
    ts: v.number(),
  }),

  modelProviders: defineTable({
    name: v.string(),
    protocol: v.union(
      v.literal("openai"),
      v.literal("anthropic"),
      v.literal("ollama"),
      v.literal("custom"),
    ),
    endpoint: v.string(),
    apiKeyRef: v.string(),  // pointer to OS keychain entry — never the cleartext key
    defaultModel: v.optional(v.string()),
    enabled: v.boolean(),
  }),

  agentPresets: defineTable({
    name: v.string(),
    icon: v.string(),
    promptTemplate: v.string(),
    schedule: v.optional(v.string()),
  }),

  promptTemplates: defineTable({
    title: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
  }),
});
