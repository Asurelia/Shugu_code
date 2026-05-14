import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query("agentPresets").collect(),
});

export const create = mutation({
  args: {
    name: v.string(),
    icon: v.string(),
    promptTemplate: v.string(),
    schedule: v.optional(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("agentPresets", args),
});
