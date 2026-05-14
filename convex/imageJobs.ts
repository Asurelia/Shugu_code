import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("imageJobs").collect()).sort((a, b) => b.ts - a.ts),
});

export const create = mutation({
  args: {
    prompt: v.string(),
    negative: v.optional(v.string()),
    ratio: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) =>
    ctx.db.insert("imageJobs", { ...args, status: "queued", ts: Date.now() }),
});

export const setStatus = mutation({
  args: {
    id: v.id("imageJobs"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    resultUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    ctx.db.patch(args.id, { status: args.status, resultUrl: args.resultUrl }),
});
