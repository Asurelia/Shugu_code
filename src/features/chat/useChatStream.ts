import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@/lib/tauri";

interface ChatDelta {
  conversationId?: string;
  chunk: string;
  done: boolean;
}

export interface ChatStreamHandle {
  streaming: boolean;
  partial: string;
  start: () => void;
  stop: () => void;
}

export function useChatStream(): ChatStreamHandle {
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");

  // cancelledRef lets stop() work even before the async listen() resolves.
  const cancelledRef = useRef(false);
  // unlistenRef holds the resolved unlisten function once available.
  const unlistenRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setStreaming(false);
    setPartial("");
  }, []);

  const start = useCallback(() => {
    // Idempotent: ignore if already streaming.
    if (streaming) return;

    cancelledRef.current = false;
    setPartial("");
    setStreaming(true);

    void listen<ChatDelta>("chat://delta", (delta) => {
      if (cancelledRef.current) return;
      if (delta.done) {
        setStreaming(false);
        unlistenRef.current?.();
        unlistenRef.current = null;
        return;
      }
      setPartial((prev) => prev + delta.chunk);
    }).then((unlisten) => {
      if (cancelledRef.current) {
        unlisten();
      } else {
        unlistenRef.current = unlisten;
      }
    });
  }, [streaming]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  return { streaming, partial, start, stop };
}
