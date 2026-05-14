import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("projects").collect()).sort((a, b) => a.order - b.order),
});

export const create = mutation({
  args: { name: v.string(), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const count = (await ctx.db.query("projects").collect()).length;
    return ctx.db.insert("projects", { name: args.name, color: args.color, order: count });
  },
});

export const rename = mutation({
  args: { id: v.id("projects"), name: v.string() },
  handler: async (ctx, args) => ctx.db.patch(args.id, { name: args.name }),
});

export const reorder = mutation({
  args: { id: v.id("projects"), order: v.number() },
  handler: async (ctx, args) => ctx.db.patch(args.id, { order: args.order }),
});

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, args) => {
    // Detach conversations belonging to this project first.
    const convos = await ctx.db.query("conversations").withIndex("by_project", (q) => q.eq("projectId", args.id)).collect();
    for (const c of convos) {
      await ctx.db.patch(c._id, { projectId: undefined });
    }
    await ctx.db.delete(args.id);
  },
});
