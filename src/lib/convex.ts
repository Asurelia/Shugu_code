import { ConvexReactClient } from "convex/react";

export const convexEnabled: boolean = !!import.meta.env.VITE_CONVEX_URL;

export const convex = new ConvexReactClient(
  (import.meta.env.VITE_CONVEX_URL as string) ?? "",
);
