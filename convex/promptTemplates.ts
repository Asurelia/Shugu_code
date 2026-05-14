import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { tag: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("promptTemplates").collect();
    return args.tag ? all.filter((t) => t.tags.includes(args.tag!)) : all;
  },
});

export const create = mutation({
  args: { title: v.string(), body: v.string(), tags: v.array(v.string()) },
  handler: async (ctx, args) => ctx.db.insert("promptTemplates", args),
});
