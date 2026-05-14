import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) =>
    ctx.db
      .query("messages")
      .withIndex("by_conv", (q) => q.eq("conversationId", args.conversationId))
      .order("asc")
      .collect(),
});

export const append = mutation({
  args: {
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("ai"), v.literal("system")),
    text: v.optional(v.string()),
    body: v.optional(v.string()),
    code: v.optional(v.object({ lang: v.string(), text: v.string() })),
    image: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("messages", { ...args, ts: Date.now() });
    await ctx.db.patch(args.conversationId, { updatedAt: Date.now() });
    return id;
  },
});
