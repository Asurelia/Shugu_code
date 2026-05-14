import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConvexProvider } from "convex/react";

import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";

import { RouterProvider } from "@tanstack/react-router";
import { ThemeBootstrap } from "./lib/ThemeBootstrap";
import { convex, convexEnabled } from "./lib/convex";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const inner = (
  <QueryClientProvider client={queryClient}>
    <ThemeBootstrap />
    <RouterProvider router={router} />
  </QueryClientProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {convexEnabled ? <ConvexProvider client={convex}>{inner}</ConvexProvider> : inner}
  </React.StrictMode>,
);
