// Shugu Forge — rendu Markdown léger pour les réponses du chat.
//
// Pourquoi maison plutôt que remark/marked : le projet refuse ~50 Ko de deps
// markdown pour un usage borné (cf. src/lib/markdown.ts). Ce module rend les
// éléments markdown que les modèles produisent réellement en chat — titres,
// listes, citations, gras/italique, code inline, liens, règles, et blocs de
// code ``` — en nœuds React (JAMAIS d'innerHTML → pas de XSS).
//
// Utilisé pour le corps persisté ET l'aperçu live (chatStream.partial) afin que
// l'expérience soit cohérente et lisible façon Codex / Claude Code, au lieu du
// `white-space: pre-wrap` brut qui affichait les balises telles quelles.

import React from "react";

// ── Inline : code `x`, lien [t](u), gras **x**/__x__, italique *x*/_x_ ──────
// Un seul regex d'alternation, parcouru dans l'ordre ; le texte entre matches
// passe tel quel. Le contenu gras/italique est re-rendu (nesting léger).
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)/g;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  let i = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) {
      // `code`
      out.push(<code key={key} className="cx-code-inline">{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      // [text](url)
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const url = tok.slice(close + 2, -1);
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="cx-md-link">
          {label}
        </a>,
      );
    } else if (m[3]) {
      // **bold** / __bold__
      const inner = tok.slice(2, -2);
      out.push(<strong key={key}>{renderInline(inner, key)}</strong>);
    } else if (m[4]) {
      // *italic* / _italic_
      const inner = tok.slice(1, -1);
      out.push(<em key={key}>{renderInline(inner, key)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Blocs ───────────────────────────────────────────────────────────────────
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const ATX_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```(.*)$/;

export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    const joined = buf.join("\n").trim();
    if (joined) blocks.push(<p key={`p-${key++}`}>{renderInline(joined, `p${key}`)}</p>);
    buf.length = 0;
  };

  let para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // Bloc de code ``` … ```
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushParagraph(para);
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // saute la fence fermante
      blocks.push(
        <pre key={`pre-${key++}`} className="cx-md-pre" data-lang={lang || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Ligne vide → fin de paragraphe
    if (line.trim() === "") {
      flushParagraph(para);
      i++;
      continue;
    }

    // Règle horizontale
    if (HR_RE.test(line)) {
      flushParagraph(para);
      blocks.push(<hr key={`hr-${key++}`} className="cx-md-hr" />);
      i++;
      continue;
    }

    // Titre ATX
    const h = line.match(ATX_RE);
    if (h) {
      flushParagraph(para);
      const level = Math.min(h[1].length, 6);
      const Tag = (`h${Math.min(level + 2, 6)}` as keyof JSX.IntrinsicElements);
      blocks.push(
        <Tag key={`h-${key++}`} className={`cx-md-h cx-md-h${level}`}>
          {renderInline(h[2].trim(), `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Citation (lignes consécutives)
    if (QUOTE_RE.test(line)) {
      flushParagraph(para);
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quote.push(lines[i].match(QUOTE_RE)![1]);
        i++;
      }
      blocks.push(
        <blockquote key={`q-${key++}`} className="cx-md-quote">
          {renderInline(quote.join("\n").trim(), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Liste à puces
    if (UL_RE.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(lines[i].match(UL_RE)![1]);
        i++;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="cx-md-ul">
          {items.map((it, k) => (
            <li key={k}>{renderInline(it, `ul${key}-${k}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Liste ordonnée
    if (OL_RE.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].match(OL_RE)![1]);
        i++;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="cx-md-ol">
          {items.map((it, k) => (
            <li key={k}>{renderInline(it, `ol${key}-${k}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Sinon : accumule en paragraphe
    para.push(line);
    i++;
  }
  flushParagraph(para);

  return <>{blocks}</>;
}
