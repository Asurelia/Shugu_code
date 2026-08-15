import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mount heavy iframe/preview content only when the frame is selected or
 * intersects the canvas viewport — otherwise a cheap placeholder.
 */
export function LazyFrame({
  active,
  title,
  placeholder,
  children,
}: {
  active: boolean;
  title: string;
  placeholder?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".studio-canvas");
    const io = new IntersectionObserver(
      ([entry]) => setVisible(!!entry?.isIntersecting),
      { root: root instanceof Element ? root : null, rootMargin: "60px", threshold: 0.02 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const mount = active || visible;

  return (
    <div ref={ref} className="studio-lazy-frame" data-title={title}>
      {mount ? (
        children
      ) : (
        <div className="studio-cnode-empty studio-lazy-ph">
          <span>{placeholder || title}</span>
          <em>Clique pour charger l’aperçu</em>
        </div>
      )}
    </div>
  );
}
