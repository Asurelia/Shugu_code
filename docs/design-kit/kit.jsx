// Shugu Kit — design system catalog
const { useState, useEffect, useRef } = React;

const NAV = [
  { group: "Foundation", items: [
    { id: "tokens",     label: "Color tokens" },
    { id: "type",       label: "Typography" },
    { id: "spacing",    label: "Spacing & radii" },
    { id: "shadows",    label: "Shadows & glows" },
  ]},
  { group: "Surfaces", items: [
    { id: "glass",      label: "Glass surfaces" },
    { id: "panels",     label: "Cards & panels" },
  ]},
  { group: "Controls", items: [
    { id: "buttons",    label: "Buttons" },
    { id: "icons",      label: "Icon buttons" },
    { id: "inputs",     label: "Inputs & textarea" },
    { id: "switches",   label: "Switches & sliders" },
    { id: "chips",      label: "Chips & badges" },
    { id: "tabs",       label: "Tabs & segmented" },
  ]},
  { group: "Patterns", items: [
    { id: "rail",       label: "Activity rail" },
    { id: "context",    label: "Context menu" },
    { id: "palette",    label: "Command palette" },
    { id: "dropdown",   label: "Account dropdown" },
    { id: "floatchat",  label: "Floating chat + mascot" },
    { id: "tweaks",     label: "Tweaks panel" },
  ]},
  { group: "Templates", items: [
    { id: "settings",   label: "Settings page" },
    { id: "conn",       label: "Provider card" },
    { id: "agent",      label: "Agent card" },
    { id: "chat",       label: "Chat message" },
  ]},
  { group: "Reference", items: [
    { id: "vars",       label: "CSS variables" },
    { id: "usage",      label: "Importing" },
  ]},
];

// ── Small helpers ─────────────────────────────────────────────
function Section({ id, title, sub, children }) {
  return (
    <section id={id} className="kit-section">
      <header className="kit-section-head">
        <h2>{title}</h2>
        {sub && <span className="sub">{sub}</span>}
        <span className="anchor">#{id}</span>
      </header>
      {children}
    </section>
  );
}

function Demo({ label, children, code }) {
  return (
    <div className="kit-demo">
      {label && <div className="kit-demo-label">{label}</div>}
      <div style={{display:"flex", flexWrap:"wrap", gap:14, alignItems:"center"}}>{children}</div>
      {code && <pre className="kit-code" dangerouslySetInnerHTML={{__html: hi(code)}}/>}
    </div>
  );
}

// tiny syntax highlight for jsx/html in code blocks
function hi(s) {
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/(\{\/\*[\s\S]*?\*\/\})/g, '<span class="c">$1</span>');
  s = s.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="k">$2</span>');
  s = s.replace(/(\w+)=(&quot;)/g, '<span class="a">$1</span>=<span class="s">$2');
  s = s.replace(/(&quot;[^&]*?&quot;)/g, (m) => `<span class="s">${m}</span>`);
  s = s.replace(/(\{[^{}\n]+\})/g, '<span class="v">$1</span>');
  return s;
}

function CodeBlock({ code }) {
  return <pre className="kit-code" dangerouslySetInnerHTML={{__html: hi(code)}}/>;
}

// ── Sections ──────────────────────────────────────────────────
function TokensSection() {
  const groups = [
    { name: "Accents", swatches: [
      ["--primary",     "#e08efe"],
      ["--secondary",   "#fd6c9c"],
      ["--tertiary",    "#81ecff"],
      ["--success",     "#8aefc7"],
      ["--warn",        "#ffcf6b"],
      ["--danger",      "#ff6a8a"],
    ]},
    { name: "Surface stack", swatches: [
      ["--surface-dim",                "#0d0d18"],
      ["--surface",                    "#101020"],
      ["--surface-container-low",      "#12121e"],
      ["--surface-container",          "#16162a"],
      ["--surface-container-high",     "#1e1e2d"],
      ["--surface-container-highest",  "#242434"],
      ["--surface-bright",             "#2b2a3c"],
    ]},
    { name: "Text", swatches: [
      ["--on-surface",          "#ece8f5"],
      ["--on-surface-variant",  "#a5a0bf"],
      ["--on-surface-muted",    "#6e6a89"],
    ]},
  ];
  return (
    <Section id="tokens" title="Color tokens" sub="Celestial Veil palette. Override any var at :root to retheme.">
      {groups.map(g => (
        <div key={g.name} style={{marginBottom: 18}}>
          <div className="kit-label">{g.name}</div>
          <div className="kit-swatch-grid">
            {g.swatches.map(([name, hex]) => (
              <div key={name} className="kit-swatch">
                <div className="chip" style={{background: `var(${name})`}}></div>
                <div className="meta">
                  <div className="name">{name.replace("--", "")}</div>
                  <div className="val">{hex}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <CodeBlock code={`:root {
  --primary:   #e08efe;
  --secondary: #fd6c9c;
  --tertiary:  #81ecff;
  /* override anywhere to retheme */
}`}/>
    </Section>
  );
}

function TypeSection() {
  const samples = [
    { weight: 800, size: 32, family: "display", text: "Sometimes you forge new constellations." },
    { weight: 700, size: 22, family: "display", text: "Shugu Forge — workshop for code & light." },
    { weight: 600, size: 16, family: "display", text: "A bold heading anchors the section." },
    { weight: 500, size: 14, family: "body", text: "Body copy stays Inter for readability and metric balance with display." },
    { weight: 400, size: 12, family: "mono",   text: "shugu/forge $ cargo run --release  # mono for terminal & code" },
    { weight: 700, size: 10, family: "mono",   text: "MONO 10 / 0.16EM · UPPERCASE LABEL" },
  ];
  return (
    <Section id="type" title="Typography" sub="Plus Jakarta Sans (display) · Inter (body) · JetBrains Mono (code & labels).">
      {samples.map((s, i) => (
        <div key={i} className="kit-type-row">
          <div className="kit-type-meta"><b>{s.family}</b> · {s.weight} / {s.size}px</div>
          <div style={{fontFamily: `var(--font-${s.family})`, fontWeight: s.weight, fontSize: s.size, letterSpacing: s.family === 'mono' ? '0.06em' : (s.size > 24 ? '-0.01em' : 0)}}>
            {s.text}
          </div>
        </div>
      ))}
      <CodeBlock code={`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=Plus+Jakarta+Sans:wght@400..800&family=JetBrains+Mono:wght@400..500&display=swap" rel="stylesheet"/>

:root {
  --font-display: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-body:    'Inter', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, monospace;
}`}/>
    </Section>
  );
}

function SpacingSection() {
  const radii = ["0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "999px"];
  return (
    <Section id="spacing" title="Spacing & radii" sub="Power-of-2-ish spacing. Pill radius `9999px` for buttons & chips, 14-22px for cards.">
      <div className="kit-label">Radii — `--r-sm` to `--r-2xl` / `--r-full`</div>
      <div style={{display:"flex", gap:14, marginBottom:18, flexWrap:"wrap"}}>
        {radii.map((r, i) => (
          <div key={i} style={{width:100, height:100, background: "linear-gradient(135deg, rgba(224,142,254,0.18), rgba(129,236,255,0.06))", border: "1px solid rgba(224,142,254,0.3)", borderRadius: r, display:"grid", placeItems:"center", fontFamily:"var(--font-mono)", fontSize:10, color:"var(--on-surface-variant)"}}>
            {r}
          </div>
        ))}
      </div>
      <div className="kit-label">Spacing scale — Tailwind-aligned</div>
      <div style={{display:"flex", gap:6, flexWrap:"wrap", alignItems:"flex-end"}}>
        {[2, 4, 8, 12, 16, 24, 32, 48].map(s => (
          <div key={s} style={{display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
            <div style={{height: s * 2, width: s * 2, background: "linear-gradient(135deg, var(--primary), var(--secondary))", borderRadius: 6}}/>
            <span style={{fontFamily:"var(--font-mono)", fontSize:10, color:"var(--on-surface-muted)"}}>{s}px</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ShadowsSection() {
  const items = [
    { name: "--glow-primary",   box: "0 0 0 1px rgba(224, 142, 254, 0.08), 0 20px 50px -20px rgba(224, 142, 254, 0.35)" },
    { name: "--glow-secondary", box: "0 0 0 1px rgba(253, 108, 156, 0.08), 0 20px 50px -20px rgba(253, 108, 156, 0.35)" },
    { name: "--glow-tertiary",  box: "0 0 0 1px rgba(129, 236, 255, 0.08), 0 20px 50px -20px rgba(129, 236, 255, 0.35)" },
  ];
  return (
    <Section id="shadows" title="Shadows & glows" sub="Tinted shadows preserve accent color instead of using grey drop shadows.">
      <div className="kit-row grid">
        {items.map(s => (
          <div key={s.name} style={{padding:24, borderRadius:16, background:"rgba(18,16,30,0.55)", border:"1px solid rgba(255,255,255,0.05)", boxShadow: s.box}}>
            <div className="kit-label" style={{marginBottom:4}}>{s.name}</div>
            <div style={{fontFamily:"var(--font-mono)", fontSize:10, color:"var(--on-surface-muted)", lineHeight:1.5}}>tinted halo</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function GlassSection() {
  return (
    <Section id="glass" title="Glass surfaces" sub="Three intensities. Use `lg` by default, `lg-strong` for modals, `lg-weak` for hovers.">
      <div className="kit-row grid">
        <div className="lg" style={{padding:24, borderRadius:18, minHeight: 120}}>
          <div className="kit-label">.lg (default)</div>
          <div style={{fontSize:13, color:"var(--on-surface-variant)"}}>Frosted, balanced.</div>
        </div>
        <div className="lg lg-strong" style={{padding:24, borderRadius:18, minHeight: 120}}>
          <div className="kit-label">.lg-strong</div>
          <div style={{fontSize:13, color:"var(--on-surface-variant)"}}>Heavier blur for modals.</div>
        </div>
        <div className="lg lg-weak" style={{padding:24, borderRadius:18, minHeight: 120}}>
          <div className="kit-label">.lg-weak</div>
          <div style={{fontSize:13, color:"var(--on-surface-variant)"}}>Almost transparent.</div>
        </div>
      </div>
      <CodeBlock code={`<div class="lg">…content…</div>
<div class="lg lg-strong">…modal content…</div>

/* Customize per element */
<div class="lg" style="--lg-blur: 24px; --lg-tint: rgba(18,14,30,0.7)">
  Heavier blur, denser tint.
</div>`}/>
    </Section>
  );
}

function PanelsSection() {
  return (
    <Section id="panels" title="Cards & panels" sub="Use `.setting-section` for settings groups; `.agent-card` for status; `.conn-card` for forms.">
      <div className="kit-row column">
        <div className="setting-section">
          <h3>Generic section</h3>
          <p className="sub">Settings group with rows.</p>
          <div className="setting-row">
            <div className="info"><div className="label">Some setting</div><div className="desc">Hint text below.</div></div>
            <div className="switch" data-on="true"></div>
          </div>
          <div className="setting-row">
            <div className="info"><div className="label">Another setting</div></div>
            <span className="chip primary">value</span>
          </div>
        </div>
      </div>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section id="buttons" title="Buttons" sub="Variants: primary · secondary · ghost · subtle · danger. Sizes: sm · md · lg.">
      <Demo label="Variants">
        <button className="lgb lgb-primary">Primary</button>
        <button className="lgb lgb-secondary">Secondary</button>
        <button className="lgb">Default (ghost)</button>
        <button className="lgb" style={{color:"var(--danger)", borderColor:"rgba(255,106,138,0.4)"}}>Danger</button>
      </Demo>
      <Demo label="Sizes" code={`<button class="lgb lgb-sm">Small</button>
<button class="lgb">Medium (default)</button>
<button class="lgb lgb-lg lgb-primary">Large</button>`}>
        <button className="lgb lgb-sm">Small</button>
        <button className="lgb">Medium</button>
        <button className="lgb lgb-lg lgb-primary">Large</button>
      </Demo>
      <Demo label="With icons">
        <button className="lgb lgb-primary"><Icon name="sparkle" size={13}/> Generate</button>
        <button className="lgb"><Icon name="git" size={11}/> Commit</button>
        <button className="lgb lgb-sm"><Icon name="copy" size={11}/> Copy</button>
        <button className="lgb lgb-sm"><Icon name="download" size={11}/> Export</button>
      </Demo>
    </Section>
  );
}

function IconsSection() {
  const names = ["chat", "code", "image", "folder", "term", "agent", "gallery", "gear", "plus", "send", "search", "bell", "x", "down", "up", "sparkle", "attach", "mic", "copy", "download", "git", "diff", "file", "shield", "history", "thumbs"];
  return (
    <Section id="icons" title="Icon buttons" sub="Set of 26 line icons. Stroke = 1.7. Currentcolor inherits from parent.">
      <div className="kit-row" style={{display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(80px, 1fr))", gap:8, padding:14}}>
        {names.map(n => (
          <div key={n} style={{display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 8px", borderRadius:8, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)", gap:6}}>
            <Icon name={n} size={18}/>
            <span style={{fontFamily:"var(--font-mono)", fontSize:9.5, color:"var(--on-surface-muted)"}}>{n}</span>
          </div>
        ))}
      </div>
      <CodeBlock code={`<Icon name="sparkle" size={16}/>
<Icon name="send"    size={14}/>`}/>
    </Section>
  );
}

function InputsSection() {
  return (
    <Section id="inputs" title="Inputs & textarea" sub="`.lgi` block + `.lgi-label` label + `.lgi-pill` for circular shape.">
      <Demo label="Standard">
        <div className="lgi-group" style={{minWidth: 260}}>
          <label className="lgi-label">API key</label>
          <input className="lgi" placeholder="sk-…" type="password"/>
        </div>
        <div className="lgi-group" style={{minWidth: 260}}>
          <label className="lgi-label">Endpoint</label>
          <input className="lgi lgi-pill" placeholder="https://api.example.com"/>
        </div>
      </Demo>
      <Demo label="Textarea (free-form)">
        <textarea className="lgi" placeholder="Describe the image…" style={{width:"100%", minHeight: 84, resize:"vertical"}}/>
      </Demo>
    </Section>
  );
}

function SwitchSliderSection() {
  const [on, setOn] = useState(true);
  const [val, setVal] = useState(28);
  return (
    <Section id="switches" title="Switches & sliders" sub="iOS-style toggles. Range slider with magenta-cyan thumb.">
      <div className="kit-row">
        <div className="switch" data-on={on ? "true" : "false"} onClick={() => setOn(o => !o)}></div>
        <span style={{fontSize:13, color:"var(--on-surface-variant)"}}>{on ? "ON" : "OFF"}</span>
        <div style={{width: 240, marginLeft: 22}}>
          <div style={{display:"flex", justifyContent:"space-between", marginBottom: 6, fontFamily:"var(--font-mono)", fontSize: 10, color:"var(--on-surface-muted)"}}><span>STEPS</span><span>{val}</span></div>
          <input className="slider" type="range" min={4} max={50} value={val} onChange={e => setVal(+e.target.value)}/>
        </div>
      </div>
    </Section>
  );
}

function ChipsSection() {
  return (
    <Section id="chips" title="Chips & badges" sub="Color-coded status labels. Tone classes: primary · secondary · tertiary · success · warn · default.">
      <div className="kit-row">
        <span className="chip">default</span>
        <span className="chip primary">primary</span>
        <span className="chip secondary">secondary</span>
        <span className="chip tertiary">tertiary</span>
        <span className="chip success">success</span>
        <span className="chip warn">warn</span>
      </div>
      <CodeBlock code={`<span class="chip primary">PRO</span>
<span class="chip success">connected</span>
<span class="chip warn">limited</span>`}/>
    </Section>
  );
}

function TabsSection() {
  const [v, setV] = useState("a");
  return (
    <Section id="tabs" title="Tabs & segmented" sub="Pill-style segmented control. Selected tab gets gradient fill.">
      <div className="kit-row">
        <div className="lg-tabs">
          {[["a","Aurora"],["b","Static"],["c","Off"]].map(([id, l]) => (
            <button key={id} className="lg-tab" aria-selected={v === id} onClick={() => setV(id)}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex", gap:6}}>
          <button className="conn-tab-btn on">AI Providers</button>
          <button className="conn-tab-btn">Dev tools</button>
          <button className="conn-tab-btn">Image services</button>
        </div>
      </div>
    </Section>
  );
}

function RailSection() {
  const [view, setView] = useState("chat");
  return (
    <Section id="rail" title="Activity rail" sub="Vertical icon column for primary navigation. Active item gets a glowing left edge.">
      <div className="kit-row" style={{padding:0, gap:0}}>
        <div style={{display:"flex", height: 380, width:"100%"}}>
          <Rail view={view} setView={setView}/>
          <div style={{flex:1, padding: 24, color:"var(--on-surface-variant)", fontSize:13}}>
            Selected view: <code style={{fontFamily:"var(--font-mono)", color: "var(--primary)"}}>{view}</code>
          </div>
        </div>
      </div>
    </Section>
  );
}

function ContextSection() {
  const [ctx, setCtx] = useState({open:false, x:0, y:0, target:null});
  const ref = useRef(null);
  const onCtx = (e) => { e.preventDefault(); setCtx({ open:true, x: e.clientX, y: e.clientY, target: { label: "selected text", kind: "selection" } }); };
  return (
    <Section id="context" title="Context menu" sub="Custom right-click menu with submenus (flag colors, tag colors). Right-click the demo area below.">
      <div className="kit-row column" onContextMenu={onCtx} ref={ref} style={{minHeight: 140, alignItems:"center", justifyContent:"center", textAlign:"center", cursor:"context-menu"}}>
        <div style={{color:"var(--on-surface-variant)", fontSize: 13}}>↳ Right-click anywhere in this card</div>
        <div style={{color:"var(--on-surface-muted)", fontSize: 11, marginTop: 6}}>Annotate · flag · tag · ask Shugu</div>
      </div>
      <ContextMenu open={ctx.open} x={ctx.x} y={ctx.y} target={ctx.target} onClose={() => setCtx(c => ({...c, open:false}))} onAnnotate={() => setCtx(c => ({...c, open:false}))}/>
    </Section>
  );
}

function PaletteSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section id="palette" title="Command palette" sub="Cmd+K spotlight. Grouped commands · arrow-key navigation · live filtering.">
      <div className="kit-row">
        <button className="lgb lgb-primary" onClick={() => setOpen(true)}>
          <Icon name="search" size={13}/> Open palette
        </button>
      </div>
      {open && <div onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <PalettePreview onClose={() => setOpen(false)}/>
      </div>}
    </Section>
  );
}

function PalettePreview({ onClose }) {
  const [q, setQ] = useState("");
  const cmds = [
    { group: "Navigate", items: [
      ["Open Chat",   "switch to conversation", "chat", "⇧⌘C"],
      ["Open Editor", "switch to code editor",  "code", "⇧⌘E"],
      ["Open Image",  "image generator",        "image", "⇧⌘I"],
    ]},
    { group: "Create", items: [
      ["New conversation", "fresh chat",   "plus", "⌘N"],
      ["Generate image",   "open prompt",  "sparkle", null],
    ]},
  ];
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-search">
          <Icon name="search" size={16}/>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Type a command…"/>
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list scroll">
          {cmds.map((g, gi) => (
            <div key={gi}>
              <div className="palette-section-label">{g.group}</div>
              {g.items.filter(it => (it[0] + it[1]).toLowerCase().includes(q.toLowerCase())).map(([name, hint, icon, kbd], i) => (
                <div key={i} className={"palette-item" + (gi === 0 && i === 0 ? " active" : "")}>
                  <div className="ico"><Icon name={icon} size={13}/></div>
                  <div className="body">
                    <div className="name">{name}</div>
                    <div className="hint">{hint}</div>
                  </div>
                  {kbd && <span className="kbd">{kbd}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑</span><span className="kbd" style={{marginLeft:2}}>↓</span> navigate</span>
          <span><span className="kbd">↵</span> run</span>
        </div>
      </div>
    </div>
  );
}

function DropdownSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section id="dropdown" title="Account dropdown" sub="Bottom-of-titlebar avatar → user menu. Shows plan, usage, quick links.">
      <div className="kit-row">
        <div style={{position:"relative", height: 50}}>
          <button className="tb-avatar" onClick={() => setOpen(o => !o)}><span>VU</span><span className="online"></span></button>
          {open && (
            <div className="account-pop" style={{position:"absolute", top: 36, right: "auto", left: 0}}>
              <div className="account-head">
                <div className="avatar">VU</div>
                <div className="who"><div className="name">Vincent Ulrich</div><div className="email">vincent@shugu.dev</div></div>
              </div>
              <div className="account-tier">
                <span className="badge">Pro</span>
                <div className="info"><div className="l">Plan</div><div className="v">Shugu Pro · <small>renews May 30</small></div></div>
              </div>
              <div className="account-menu">
                <button className="account-item"><span className="ico"><Icon name="agent" size={13}/></span>Account & Profile</button>
                <button className="account-item"><span className="ico"><Icon name="folder" size={13}/></span>Connections & API keys</button>
                <button className="account-item danger"><span className="ico"><Icon name="x" size={13}/></span>Sign out</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function FloatChatSection() {
  return (
    <Section id="floatchat" title="Floating chat + mascot" sub="Always-on-top assistant. Mascot is the anchor — drag to move, click to toggle, snap to edges to hide.">
      <div className="kit-row" style={{padding:0, height: 280, position:"relative", overflow:"hidden"}}>
        <div style={{position:"absolute", inset:14, border:"1px dashed rgba(255,255,255,0.08)", borderRadius:14, display:"grid", placeItems:"center", color:"var(--on-surface-muted)", fontFamily:"var(--font-mono)", fontSize:11}}>
          The widget is visible at the bottom-right of the page →
          <br/>(drag the astronaut anywhere; throw it against a border to tuck it)
        </div>
      </div>
      <CodeBlock code={`<FloatChat pinnedAnno={null} clearPinned={()=>{}}/>

/* Behaviour summary */
- Drag mascot → reposition anywhere
- Mascot.x < width/2  → panel opens to the right
- Mascot.x > width/2  → panel opens to the left
- Near an edge       → tucks against it (rotated 90°), panel hidden
- Click mascot        → toggle compact ↔ closed
- Double-click       → toggle compact ↔ full (with history)
- Right-click         → flip side manually`}/>
    </Section>
  );
}

function TweaksSection() {
  return (
    <Section id="tweaks" title="Tweaks panel" sub="In-design controls for live theming. Toggle from the Forge titlebar to expose it. Persisted to the source file.">
      <CodeBlock code={`const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": ["#e08efe", "#fd6c9c", "#81ecff"],
  "glassBlur": 12,
  "glassTint": 55
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  return <TweaksPanel title="Tweaks">
    <TweakSection title="Palette">
      <TweakColor label="Accent set" value={tweaks.palette}
                  onChange={v => setTweak('palette', v)}
                  options={[…]}/>
    </TweakSection>
  </TweaksPanel>;
}`}/>
    </Section>
  );
}

function SettingsSection() {
  return (
    <Section id="settings" title="Settings page template" sub="Two-column: rail with sections, body with `.setting-section` groups.">
      <div className="kit-demo" style={{padding:0, overflow:"hidden"}}>
        <div style={{display:"grid", gridTemplateColumns:"220px 1fr", height: 340}}>
          <div style={{borderRight:"1px solid rgba(255,255,255,0.05)", padding:"16px 0"}}>
            {["General", "Account & Profile", "Connections", "Image Generation", "Editor", "Shortcuts", "Privacy", "About"].map((s, i) => (
              <div key={s} style={{padding:"8px 16px", fontSize:13, color: i === 2 ? "var(--on-surface)" : "var(--on-surface-variant)", background: i === 2 ? "linear-gradient(90deg, rgba(224,142,254,0.18), transparent)" : "transparent", margin:"0 8px", borderRadius: 8}}>{s}</div>
            ))}
          </div>
          <div style={{padding:18}}>
            <h3 style={{fontFamily:"var(--font-display)", fontWeight:700, fontSize:14, margin:0}}>Connections</h3>
            <p style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:4}}>Branche tes outils externes…</p>
          </div>
        </div>
      </div>
    </Section>
  );
}

function ProviderCardSection() {
  return (
    <Section id="conn" title="Provider card" sub="Form-in-a-card pattern. Status badge + field stack + action row.">
      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap: 12}}>
        <ConnCard c={{id:"k1", name:"Anthropic", meta:"Claude / Shugu models", logo:"A", color:"#d97757", status:"connected", fields:[["API key", "sk-ant-…", true]]}}/>
        <ConnCard c={{id:"k2", name:"OpenAI", meta:"GPT-4o, o1, embeddings", logo:"O", color:"#10a37f", status:"disconnected", fields:[["API key", "sk-…", true]]}}/>
        <div className="conn-add-card">
          <span className="plus"><Icon name="plus" size={18}/></span>
          <div className="t">Add custom provider</div>
          <div className="s">OpenAI-compatible endpoint</div>
        </div>
      </div>
    </Section>
  );
}

function AgentCardSection() {
  return (
    <Section id="agent" title="Agent card" sub="Long-running task surface. `.running` adds animated top-bar; progress bar at bottom.">
      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(320px, 1fr))", gap: 12}}>
        {[
          { id:"a1", name:"Refactor Pass", icon:"🔧", status:"running", desc:"Splitting store.ts into slices.", log:"▸ analyzing store shape\n▸ extracting chat slice…", elapsed:"00:42", progress:64 },
          { id:"a2", name:"Veil Curator",  icon:"🎨", status:"done",    desc:"Tagged 240 generations.",      log:"✓ 240 / 240 tagged",                  elapsed:"06:02", progress:100 },
        ].map(a => (
          <div key={a.id} className={"agent-card " + a.status}>
            <div className="head">
              <div className="who">
                <span className="ico" style={{background:"linear-gradient(135deg, var(--primary), var(--secondary))"}}>{a.icon}</span>
                {a.name}
              </div>
              <span className={"chip " + (a.status === 'running' ? 'tertiary' : 'success')}>{a.status}</span>
            </div>
            <div className="desc">{a.desc}</div>
            <div className="log">{a.log}</div>
            <div className="foot">
              <span>{a.elapsed}</span>
              <div className="progress"><div className="fill" style={{width: a.progress + "%"}}></div></div>
              <span>{a.progress}%</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ChatMessageSection() {
  return (
    <Section id="chat" title="Chat message" sub="`.msg.user` / `.msg.ai` with avatar, time, attribution, and body (text + code blocks + inline images).">
      <div style={{padding:18, background:"rgba(18, 16, 30, 0.5)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14, display:"flex", flexDirection:"column", gap:18}}>
        <div className="msg user">
          <div className="avatar">VU</div>
          <div className="body">
            <div className="who">You <span className="ts">— 14:30</span></div>
            <div className="text">How do I forward a Tauri event to Zustand without losing the type narrowing?</div>
          </div>
        </div>
        <div className="msg ai">
          <div className="avatar">S</div>
          <div className="body">
            <div className="who">Shugu <span className="ts">— 14:30</span><span className="chip primary" style={{marginLeft:4}}>haiku-4-5</span></div>
            <div className="text">
              Use a typed event channel: declare <code>ChatDelta</code> once, narrow on the union tag inside the listener.
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function VarsSection() {
  const rows = [
    { v: "--primary",    val: "#e08efe", swatch: true, use: "Accents, gradients, focus rings" },
    { v: "--secondary",  val: "#fd6c9c", swatch: true, use: "Secondary CTA, pink halos" },
    { v: "--tertiary",   val: "#81ecff", swatch: true, use: "Info, success-ish, cool accents" },
    { v: "--success",    val: "#8aefc7", swatch: true, use: "Status: connected, OK" },
    { v: "--warn",       val: "#ffcf6b", swatch: true, use: "Status: warning, idle" },
    { v: "--danger",     val: "#ff6a8a", swatch: true, use: "Errors, destructive actions" },
    { v: "--surface",    val: "#101020", swatch: true, use: "Default backdrop" },
    { v: "--lg-blur",    val: "12px",    swatch: false, use: "Backdrop blur amount on .lg" },
    { v: "--lg-tint",    val: "rgba(18,14,30,0.55)", swatch: false, use: "Tint over backdrop" },
    { v: "--r-md",       val: "0.75rem", swatch: false, use: "Default card radius (smaller)" },
    { v: "--r-xl",       val: "1.5rem",  swatch: false, use: "Pill button, modal radius" },
    { v: "--font-display", val: "'Plus Jakarta Sans'", swatch: false, use: "Headings, brand" },
    { v: "--font-body",    val: "'Inter'",             swatch: false, use: "Body copy" },
    { v: "--font-mono",    val: "'JetBrains Mono'",    swatch: false, use: "Code, labels, monospace meta" },
  ];
  return (
    <Section id="vars" title="CSS variables" sub="Override at :root, on a parent element, or inline. The whole kit responds.">
      <div className="kit-vars">
        <div className="kit-var-row head"><span>Variable</span><span>Value</span><span>Used for</span></div>
        {rows.map(r => (
          <div key={r.v} className="kit-var-row">
            <span className="kit-var-name">{r.swatch && <span className="swatch" style={{background: r.val}}/>}{r.v}</span>
            <span className="kit-var-val">{r.val}</span>
            <span className="kit-var-use">{r.use}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function UsageSection() {
  return (
    <Section id="usage" title="Importing & customizing" sub="Drop the files into any project. React 18 + Babel. No build step required.">
      <CodeBlock code={`{/* In your HTML <head> */}
<link rel="stylesheet" href="styles.css"/>
<link rel="stylesheet" href="panels.css"/>

{/* React + Babel UMD (pinned) */}
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>

{/* Shugu kit scripts (load in this order) */}
<script type="text/babel" src="tweaks-panel.jsx"></script>
<script type="text/babel" src="components.jsx"></script>
<script type="text/babel" src="panels.jsx"></script>
<script type="text/babel" src="app.jsx"></script>`}/>

      <CodeBlock code={`{/* Retheme in 2 lines */}
:root {
  --primary:   #7cffd1;
  --secondary: #81ecff;
}

{/* Or wrap a subtree */}
<div style={{ "--primary": "#ffae34", "--secondary": "#ff5dcd" }}>
  <button className="lgb lgb-primary">Now orange/pink</button>
</div>`}/>

      <CodeBlock code={`{/* Available React components */}
<Icon name="sparkle"/>
<Rail view={v} setView={setV}/>
<Titlebar onSearch={…} onAvatar={…}/>
<DockHostMount dockState={…} setDockState={…}/>
<ContextMenu open={…} x={…} y={…} target={…} onClose={…} onAnnotate={…}/>
<AccountDropdown open={…} onClose={…} onView={…}/>
<FloatChat pinnedAnno={…} clearPinned={…}/>
<Chibi size={92}/>
<ConnCard c={{name, meta, logo, color, status, fields:[…]}}/>
<AddProviderModal onClose={…} onAdd={…}/>
<ModelPicker model={…} onChange={…}/>`}/>
    </Section>
  );
}

function Kit() {
  const [active, setActive] = useState("tokens");

  useEffect(() => {
    const onScroll = () => {
      const sections = NAV.flatMap(g => g.items).map(i => i.id);
      for (const id of sections) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top <= 120 && r.bottom > 120) { setActive(id); break; }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="kit-root">
      <aside className="kit-rail">
        <div className="kit-brand">
          <div className="mark"></div>
          <div>
            <div className="name">Shugu Kit</div>
            <div className="v">v0.4.0 · celestial veil</div>
          </div>
        </div>
        <nav className="kit-nav">
          {NAV.map(g => (
            <div key={g.group}>
              <div className="kit-nav-section">{g.group}</div>
              {g.items.map(it => (
                <a key={it.id} href={"#" + it.id} className={active === it.id ? "on" : ""} onClick={() => setActive(it.id)}>{it.label}</a>
              ))}
            </div>
          ))}
          <div style={{padding: "16px 12px"}}>
            <a href="Shugu Forge.html" style={{display:"flex", alignItems:"center", gap:8, padding:"9px 12px", borderRadius:10, background:"linear-gradient(135deg, var(--primary), var(--secondary))", color:"#1a0a24", fontWeight:700, fontSize:12.5, textDecoration:"none"}}>
              <Icon name="up" size={12}/> Open full Forge demo
            </a>
          </div>
        </nav>
      </aside>

      <main className="kit-main">
        <div className="kit-hero">
          <div className="text">
            <h1><span className="acc">Shugu Kit</span></h1>
            <div className="lede">
              Le système de design derrière Shugu Forge. Glass · neon · liquid.
              Tokens, composants et patterns prêts à déposer dans un projet Tauri/React.
              Tout est <strong>thématisable</strong> via CSS variables — change <code>--primary</code> et tout se réaccorde.
            </div>
          </div>
          <div className="stats">
            <div className="stat"><div className="n">26</div><div className="l">Icons</div></div>
            <div className="stat"><div className="n">42</div><div className="l">Components</div></div>
            <div className="stat"><div className="n">14</div><div className="l">Tokens</div></div>
          </div>
        </div>

        <TokensSection/>
        <TypeSection/>
        <SpacingSection/>
        <ShadowsSection/>
        <GlassSection/>
        <PanelsSection/>
        <ButtonsSection/>
        <IconsSection/>
        <InputsSection/>
        <SwitchSliderSection/>
        <ChipsSection/>
        <TabsSection/>
        <RailSection/>
        <ContextSection/>
        <PaletteSection/>
        <DropdownSection/>
        <FloatChatSection/>
        <TweaksSection/>
        <SettingsSection/>
        <ProviderCardSection/>
        <AgentCardSection/>
        <ChatMessageSection/>
        <VarsSection/>
        <UsageSection/>
      </main>

      {/* Live floating chat (so the user can interact with it on this page) */}
      <FloatChat pinnedAnno={null} clearPinned={() => {}}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Kit/>);
