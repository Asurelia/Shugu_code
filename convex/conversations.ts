import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { projectId: v.optional(v.id("projects")), status: v.optional(v.union(v.literal("active"), v.literal("archived"))) },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("conversations").withIndex("by_updated").order("desc").collect();
    return all.filter((c) =>
      (args.projectId == null || c.projectId === args.projectId) &&
      (args.status == null || (args.status === "archived" ? c.archived : !c.archived))
    );
  },
});

export const get = query({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

export const create = mutation({
  args: { title: v.string(), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    return ctx.db.insert("conversations", {
      title: args.title,
      projectId: args.projectId,
      pinned: false,
      archived: false,
      unread: false,
      updatedAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { id: v.id("conversations"), title: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { title: args.title, updatedAt: Date.now() });
  },
});

export const setPinned = mutation({
  args: { id: v.id("conversations"), pinned: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { pinned: args.pinned });
  },
});

export const archive = mutation({
  args: { id: v.id("conversations"), archived: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { archived: args.archived });
  },
});

export const remove = mutation({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
