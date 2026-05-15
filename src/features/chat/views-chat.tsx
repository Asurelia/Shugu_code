// Shugu Forge — Chat + Image views (ported from views-chat.jsx)
// highlightRust returns JSX tokens (no innerHTML injection — XSS-safe by construction).

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "@/components/components";
import { invoke } from "@/lib/tauri";
import { useChatStream } from "./useChatStream";
import { useMessages, sendChatMessage } from "./chat-sync";
import { resolveImageProvider } from "@/lib/imageProviders";

type ImageResult = {
  id: number | string;
  prompt: string;
  ratio: string;
  model: string;
  seed: number;
  steps: number;
  guidance: number;
  style: string;
  hue: number;
  ts: string;
  status?: string;
  resultUrl?: string | null;
};

// ─── Chat ───────────────────────────────────────────────────
//
// ChatView reads its message list from the shared chat-sync layer, which
// is backed by SQLite (Tauri) or an in-memory module-level cache (web mode).
// Cross-window sync with the mascot's FloatChat rides on the
// chat://messages-changed Tauri event — both windows render the same
// SQLite truth.
export function ChatView({ activeConv, model }: { activeConv: string; model: string }) {
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [mode, setMode] = useState("chat");
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatStream = useChatStream();
  const { data: messages } = useMessages(activeConv);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, typing, chatStream.partial]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setTyping(true);
    chatStream.start();
    try {
      await sendChatMessage(activeConv, text, model);
    } finally {
      setTyping(false);
      chatStream.stop();
    }
  }, [input, model, activeConv, chatStream]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="chat-shell">
      <div className="chat-feed scroll" ref={feedRef}>
        <div className="chat-feed-inner">
          {messages.map((m: any) => <ChatMessage key={m.id} m={m}/>)}
          {typing && (
            <div className="msg ai">
              <div className="avatar">S</div>
              <div className="body">
                <div className="who">Shugu <span className="ts">— {model}</span></div>
                {chatStream.streaming && chatStream.partial
                  ? <div className="text"><p>{chatStream.partial}</p></div>
                  : <div className="typing"><span className="d"></span><span className="d"></span><span className="d"></span></div>
                }
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={mode === "image" ? "Décris l'image que tu veux générer…" : "Demande à Shugu (Tab pour passer en /image, Cmd+K pour les commandes)"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
          />
          <div className="composer-bar">
            <div className="composer-tools">
              <button className="composer-tool" title="Attach"><Icon name="attach" size={15}/></button>
              <button className={"composer-tool" + (mode === "image" ? " on" : "")} onClick={() => setMode(m => m === "image" ? "chat" : "image")} title="Image mode"><Icon name="image" size={15}/></button>
              <button className="composer-tool" title="Code block"><Icon name="code" size={15}/></button>
              <button className="composer-tool" title="Voice"><Icon name="mic" size={15}/></button>
            </div>
            <div className="composer-spacer"></div>
            <button className="composer-model" title="Choose model">
              <span className="ind"></span>
              {model}
              <Icon name="down" size={11}/>
            </button>
            <button className="composer-send" onClick={send} disabled={!input.trim()} title="Send">
              <Icon name="send" size={15}/>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatMessage({ m }: any) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="avatar">VU</div>
        <div className="body">
          <div className="who">You <span className="ts">— {m.ts}</span></div>
          <div className="text">{m.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg ai">
      <div className="avatar">S</div>
      <div className="body">
        <div className="who">Shugu <span className="ts">— {m.ts}</span><span className="chip primary" style={{marginLeft:4}}>shugu-haiku</span></div>
        <div className="text">
          {m.body && <p>{m.body}</p>}
          {m.code && <CodeBlock lang={m.code.lang} text={m.code.text}/>}
          {m.image && <InlineImage prompt="dreamy aurora, soft pinks and cyan"/>}
        </div>
      </div>
    </div>
  );
}

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="lang"><span className="dot"></span> {lang}</span>
        <span style={{display:"flex", gap:6}}>
          <button className="composer-tool" title="Copy"><Icon name="copy" size={12}/></button>
          <button className="composer-tool" title="Open in editor"><Icon name="code" size={12}/></button>
        </span>
      </div>
      <pre><code>{highlightRust(text)}</code></pre>
    </div>
  );
}

export function InlineImage({ prompt: _prompt }: { prompt?: string }) {
  return (
    <div className="inline-image" style={{flexDirection:"column"}}>
      <div style={{position:"relative", aspectRatio: "16 / 9", background: "radial-gradient(circle at 30% 30%, #ff9ec7 0%, transparent 50%), radial-gradient(circle at 70% 70%, #81ecff 0%, transparent 50%), radial-gradient(circle at 60% 30%, #e08efe 0%, transparent 55%), linear-gradient(135deg, #2a1437 0%, #0d0d18 100%)"}}>
        <div style={{position:"absolute", inset:0, backgroundImage: "radial-gradient(1px 1px at 13% 22%, rgba(255,255,255,0.4), transparent), radial-gradient(1px 1px at 47% 61%, rgba(255,255,255,0.3), transparent), radial-gradient(1px 1px at 72% 33%, rgba(255,255,255,0.4), transparent)", mixBlendMode:"overlay"}}/>
      </div>
      <div className="inline-image-meta">
        <span className="chip secondary">flux.1-veil</span>
        <span>16:9 · 1024×576 · seed 8204</span>
        <span style={{flex:1}}></span>
        <button className="lgb lgb-sm"><Icon name="download" size={12}/> Save</button>
        <button className="lgb lgb-sm"><Icon name="sparkle" size={12}/> Variations</button>
      </div>
    </div>
  );
}

// ─── Image view (dedicated) ─────────────────────────────────
export function ImageView({ generations, setGenerations }: any) {
  const [prompt, setPrompt] = useState("celestial veil over a quiet ocean at dusk, soft purples and cyan, painterly");
  const [negative, setNegative] = useState("");
  const [ratio, setRatio] = useState("1:1");
  const [seed, setSeed] = useState(8204);
  const [steps, setSteps] = useState(28);
  const [guidance, setGuidance] = useState(7.5);
  const [model, setModel] = useState("flux.1-veil");
  const [styleKey, setStyleKey] = useState("painterly");
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<any>(null);

  const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16"];
  const styles = ["painterly", "cinematic", "vector", "anime", "photo", "3d"];

  const generate = async () => {
    setBusy(true);
    setCurrent(null);
    try {
      const { protocol, baseUrl, model: realModel } = resolveImageProvider(model);
      const raw = await invoke<any>("image_generate", {
        prompt, negative, ratio, model: realModel, protocol, baseUrl,
        seed, steps, guidance, style: styleKey,
      });
      // Normalize: mock returns rich object; Rust returns sparse {id, status, resultUrl}.
      const derivedHue = [...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
      const normalized: ImageResult = {
        id:        raw.id       ?? Date.now(),
        prompt,
        ratio,
        model,
        seed,
        steps,
        guidance,
        style:     styleKey,
        hue:       typeof raw.hue === "number" ? raw.hue : derivedHue,
        ts:        raw.ts       ?? nowTime(),
        status:    raw.status,
        resultUrl: raw.resultUrl ?? null,
      };
      setCurrent(normalized);
      setGenerations((g: any[]) => [normalized, ...g]);
      setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  const bg = current
    ? `radial-gradient(circle at 30% 30%, hsl(${current.hue} 80% 70%) 0%, transparent 50%), radial-gradient(circle at 70% 70%, hsl(${(current.hue+60)%360} 80% 60%) 0%, transparent 50%), radial-gradient(circle at 60% 30%, hsl(${(current.hue+120)%360} 80% 60%) 0%, transparent 55%), linear-gradient(135deg, #2a1437 0%, #0d0d18 100%)`
    : undefined;

  return (
    <div className="image-shell">
      <div className="image-canvas">
        <div className="image-stage">
          {busy && (
            <div className="loading">
              <div className="ring"></div>
              <div style={{fontFamily:"var(--font-mono)",fontSize:"12px",color:"var(--on-surface-variant)"}}>
                Generating <span style={{color:"var(--primary)"}}>{steps}</span> steps · seed {seed}
              </div>
            </div>
          )}
          {!busy && current && (
            <div className="preview">
              <div className="img-content" style={{background: bg}}></div>
              <div className="img-grain"></div>
              <div style={{position:"absolute", left:14, bottom:14, right:14, display:"flex", gap:8}}>
                <button className="lgb lgb-sm"><Icon name="download" size={12}/> Save</button>
                <button className="lgb lgb-sm"><Icon name="sparkle" size={12}/> Variations</button>
                <button className="lgb lgb-sm"><Icon name="copy" size={12}/> Copy prompt</button>
                <span style={{flex:1}}></span>
                <span className="chip" style={{background:"rgba(0,0,0,0.5)"}}>seed {current.seed}</span>
              </div>
            </div>
          )}
          {!busy && !current && (
            <div className="empty">
              <Icon name="sparkle" size={28}/>
              <div style={{marginTop:10}}>WAITING FOR PROMPT</div>
            </div>
          )}
        </div>
        <div style={{marginTop:14, display:"flex", gap:8, alignItems:"center"}}>
          <span className="chip">{model}</span>
          <span className="chip tertiary">{ratio}</span>
          <span className="chip" style={{textTransform:"none"}}>{styleKey}</span>
          <span style={{flex:1}}></span>
          <span style={{fontSize:11, fontFamily:"var(--font-mono)", color:"var(--on-surface-muted)"}}>{generations.length} in this session</span>
        </div>
      </div>

      <div className="image-controls scroll" style={{paddingLeft:0}}>
        <div className="panel">
          <div className="panel-title">Prompt</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="A dreamy aurora over still water…"/>
          <div className="label-row"><span className="l">Negative</span></div>
          <textarea value={negative} onChange={e => setNegative(e.target.value)} placeholder="blurry, watermark…" style={{minHeight:54}}/>
          <button className="lgb lgb-primary lgb-lg" style={{width:"100%", marginTop:14}} onClick={generate} disabled={busy}>
            <Icon name="sparkle" size={14}/> {busy ? "Generating…" : "Generate"}
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Composition</div>
          <div className="label-row"><span className="l">Ratio</span><span className="v">{ratio}</span></div>
          <div className="ratio-row">
            {ratios.map(r => (
              <button key={r} className={"ratio-btn" + (r === ratio ? " on" : "")} onClick={() => setRatio(r)}>{r}</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Style</span></div>
          <div className="style-chips">
            {styles.map(s => (
              <button key={s} className={"style-chip" + (s === styleKey ? " on" : "")} onClick={() => setStyleKey(s)}>{s}</button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Sampling</div>
          <div className="label-row"><span className="l">Model</span><span className="v">{model}</span></div>
          <div className="ratio-row" style={{flexDirection:"column", gap:6}}>
            {["flux.1-veil", "sdxl-celestial", "shugu-lcm-fast"].map(m => (
              <button key={m} className={"ratio-btn" + (m === model ? " on" : "")} style={{textAlign:"left", padding:"8px 12px"}} onClick={() => setModel(m)}>{m}</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Steps</span><span className="v">{steps}</span></div>
          <input type="range" min={4} max={50} value={steps} onChange={e => setSteps(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Guidance</span><span className="v">{guidance.toFixed(1)}</span></div>
          <input type="range" min={1} max={15} step={0.5} value={guidance} onChange={e => setGuidance(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Seed</span><span className="v">{seed}</span></div>
          <input type="range" min={0} max={99999} value={seed} onChange={e => setSeed(+e.target.value)} className="slider"/>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────
export function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

// Lightweight Rust tokenizer that emits JSX (no innerHTML). XSS-safe by construction.
const RUST_KEYWORDS = new Set(["fn","let","mut","use","pub","struct","impl","return","if","else","match","Err","Ok","Some","None","Result","String","i32","u32","f32","bool"]);

type Token = { cls: string | null; text: string };

function tokenizeRust(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  const push = (cls: string | null, text: string) => { if (text) tokens.push({ cls, text }); };
  while (i < n) {
    const c = src[i];
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < n && src[j] !== "\n") j++;
      push("c", src.slice(i, j)); i = j; continue;
    }
    // string
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      push("s", src.slice(i, j)); i = j; continue;
    }
    // attribute #[...]
    if (c === "#" && src[i + 1] === "[") {
      let j = i + 2, depth = 1;
      while (j < n && depth > 0) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        j++;
      }
      push("p", src.slice(i, j)); i = j; continue;
    }
    // number
    if (/[0-9]/.test(c)) {
      let j = i; while (j < n && /[0-9.]/.test(src[j])) j++;
      push("n", src.slice(i, j)); i = j; continue;
    }
    // identifier
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (RUST_KEYWORDS.has(word)) push("k", word);
      else if (src[j] === "(") push("f", word);
      else push(null, word);
      i = j; continue;
    }
    // anything else
    let j = i;
    while (j < n && !/[\/"#0-9A-Za-z_]/.test(src[j])) j++;
    push(null, src.slice(i, j || i + 1));
    i = Math.max(j, i + 1);
  }
  return tokens;
}

export function highlightRust(text: string): React.ReactNode[] {
  return tokenizeRust(text).map((t, idx) =>
    t.cls ? <span key={idx} className={t.cls}>{t.text}</span> : <React.Fragment key={idx}>{t.text}</React.Fragment>
  );
}
