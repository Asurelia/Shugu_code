import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query("modelProviders").collect(),
});

export const upsert = mutation({
  args: {
    id: v.optional(v.id("modelProviders")),
    name: v.string(),
    protocol: v.union(v.literal("openai"), v.literal("anthropic"), v.literal("ollama"), v.literal("custom")),
    endpoint: v.string(),
    apiKeyRef: v.string(),
    defaultModel: v.optional(v.string()),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (args.id) {
      await ctx.db.patch(args.id, args);
      return args.id;
    }
    return ctx.db.insert("modelProviders", {
      name: args.name,
      protocol: args.protocol,
      endpoint: args.endpoint,
      apiKeyRef: args.apiKeyRef,
      defaultModel: args.defaultModel,
      enabled: args.enabled,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("modelProviders") },
  handler: async (ctx, args) => ctx.db.delete(args.id),
});
