import { ConvexReactClient } from "convex/react";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

export const convexEnabled: boolean = !!url;

// Only construct the client when a real URL is configured.
// `new ConvexReactClient("")` throws "Provided address was not an absolute URL"
// at module-eval time — which would break main.tsx's import chain and white-screen
// the whole app in web/dev mode. When Convex is not configured this stays null and
// main.tsx simply does not mount <ConvexProvider> (see the convexEnabled guard there).
export const convex = convexEnabled ? new ConvexReactClient(url as string) : null;
