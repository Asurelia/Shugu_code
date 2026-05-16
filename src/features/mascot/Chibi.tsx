// Shugu Forge — Chibi mascot component.
//
// 7 hand-drawn PNG expressions (5 chat moods + 2 peek poses) form the
// mascot's facial-state vocabulary. The peek poses are used only when the
// mascot is tucked against a screen edge (geometry, not emotion).
//
// PNG assets live in public/assets/chibi/ → served at /assets/chibi/*
// (works identically in `pnpm dev` web mode and the bundled Tauri webview).
//
// This is a PURE visual component. State + mood derivation lives in
// `useChibiMood` (next door in this folder) so the same chibi can be
// rendered with any host's mood signal (FloatChat today, TaskMascot or
// AgentLog tomorrow).

export type ChibiMood =
  | "neutral" | "smile" | "joy" | "sad" | "cry"
  | "peek_open" | "peek_closed";

const CHIBI_VARIANTS: Record<ChibiMood, string> = {
  neutral: "/assets/chibi/neutral.png", // calm idle, blue eyes
  smile:   "/assets/chibi/smile.png",   // content, closed eyes
  joy:     "/assets/chibi/joy.png",     // excited, eyes squished shut
  sad:     "/assets/chibi/sad.png",     // worried / half-closed eyes
  cry:     "/assets/chibi/cry.png",     // big teary eyes
  // Peek poses — the figure grips the edge with its hands, the rest
  // off-screen. peek_open = new LLM reply waiting; peek_closed = idle.
  peek_open:   "/assets/chibi/peek_open.png",
  peek_closed: "/assets/chibi/peek_closed.png",
};

const CHIBI_LABELS: Record<ChibiMood, string> = {
  neutral: "Calme",
  smile: "Content·e",
  joy: "Excité·e",
  sad: "Triste",
  cry: "Pleure",
  peek_open: "Coucou !",
  peek_closed: "Repos",
};

export interface ChibiProps {
  size?: number;
  mood?: ChibiMood;
}

export function Chibi({ size = 92, mood = "neutral" }: ChibiProps) {
  const src = CHIBI_VARIANTS[mood] || CHIBI_VARIANTS.neutral;
  const isPeek = mood === "peek_open" || mood === "peek_closed";
  // Peek poses are stickers — render smaller and squarer than the
  // full-body chibi so the head fills the visible area at the edge.
  const w = isPeek ? Math.round(size * 0.4) : size;
  const h = isPeek ? Math.round(size * 0.4) : Math.round(size * 1.2);
  return (
    <div className={"chibi-mascot mood-" + mood} style={{ width: w, height: h }}>
      <img
        src={src}
        alt={"Shugu — " + (CHIBI_LABELS[mood] || mood)}
        draggable={false}
        width={w}
        height={h}
      />
    </div>
  );
}
