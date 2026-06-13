//! Filtre de flux pour les modèles qui émettent leur raisonnement et leurs
//! appels d'outils EN TEXTE dans `delta.content` (au lieu des champs OpenAI
//! `reasoning_content` / `tool_calls`). Cas concret : MiniMax M2/M3 sur
//! api.minimax.io — leur doc impose de parser le format soi-même côté client.
//!
//! Ce que le modèle envoie dans `content` :
//!   * `<think>…</think>`            → raisonnement (doit aller au canal repliable)
//!   * `<minimax:tool_call>…</…>`    → appels d'outils en XML (format natif)
//!     ou la variante courte `<tool_call>…</tool_call>`
//!   * des jetons de frontière qui fuient : `]<]minimax[>[`, `]~b]ai`, `[e~[`…
//!
//! Le [`MinimaxContentFilter`] est un automate STREAMING : on lui pousse chaque
//! fragment SSE via [`feed`](MinimaxContentFilter::feed) et il renvoie les
//! deltas STABLES à émettre — prose visible nettoyée (canal "content") et
//! raisonnement (canal "reasoning"). Les blocs d'outils sont mis de côté
//! (cachés du corps visible au Lot 1 ; parsés et exécutés au Lot 2).
//!
//! Robustesse aux coupures de fragments : un tag (`<think>`, `<minimax:tool_call>`)
//! ou un jeton spécial peut être coupé en deux entre deux chunks SSE. On
//! re-analyse donc TOUT le buffer brut à chaque `feed`, et on RETIENT une marge
//! de fin (`HOLDBACK`) ≥ au plus long marqueur avant d'émettre — ainsi on
//! n'émet jamais un caractère qui s'avèrerait ensuite appartenir à un marqueur.
//! [`finish`](MinimaxContentFilter::finish) vide la marge restante.
//!
//! No-op pour les providers bien élevés (OpenAI, Claude…) : sans aucun de ces
//! marqueurs, `visible == content` à l'identique, `reasoning` vide, zéro bloc
//! outil — donc aucune régression sur le chemin openai-compat partagé.

/// Marge de fin retenue avant émission (≥ au plus long marqueur géré,
/// `</minimax:tool_call>` = 20 octets). 32 laisse de la marge pour d'éventuels
/// jetons spéciaux plus longs. La marge est toujours vidée par `finish`.
const HOLDBACK: usize = 32;

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";
// Ouvertures de bloc d'outils, longue (officielle) puis courte (observée M3).
const TOOL_OPENERS: &[(&str, &str)] = &[
    ("<minimax:tool_call>", "</minimax:tool_call>"),
    ("<tool_call>", "</tool_call>"),
];

/// Jetons spéciaux qui fuient dans le texte visible — retirés tels quels.
const LEAK_TOKENS: &[&str] = &[
    "]<]minimax[>[",
    "]~!b[",
    "[e~[",
    "]~b]system",
    "]~b]user",
    "]~b]ai",
    "]~b]tool",
    "]~b]",
];

/// Deltas STABLES produits par un `feed`/`finish` — prêts à être émis tels quels.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct FilterEmit {
    /// Nouveau texte visible (prose nettoyée) à concaténer + streamer "content".
    pub visible: String,
    /// Nouveau texte de raisonnement à streamer "reasoning".
    pub reasoning: String,
}

#[derive(Default)]
pub(crate) struct MinimaxContentFilter {
    raw: String,
    emitted_visible: usize,
    emitted_reasoning: usize,
    /// Blocs d'outils XML complets, dans l'ordre (corps SANS les tags ouvrants/
    /// fermants). Consommés par le Lot 2 ; au Lot 1 on n'expose que le compte.
    tool_blocks: Vec<String>,
}

/// Résultat d'une analyse complète du buffer brut.
struct Partition {
    visible: String,
    reasoning: String,
    tool_blocks: Vec<String>,
}

/// Retire les jetons spéciaux qui fuient d'un fragment de texte visible.
fn strip_leak_tokens(s: &str) -> String {
    let mut out = s.to_string();
    for tok in LEAK_TOKENS {
        if out.contains(tok) {
            out = out.replace(tok, "");
        }
    }
    out
}

/// Trouve le 1er marqueur d'ouverture (think OU un opener d'outil) à partir de
/// `from`. Renvoie (position, longueur, kind) ; kind: 0 = think, 1.. = index+1
/// dans TOOL_OPENERS.
fn next_opener(raw: &str, from: usize) -> Option<(usize, usize, usize)> {
    let mut best: Option<(usize, usize, usize)> = None;
    if let Some(p) = raw[from..].find(THINK_OPEN) {
        best = Some((from + p, THINK_OPEN.len(), 0));
    }
    for (i, (open, _close)) in TOOL_OPENERS.iter().enumerate() {
        if let Some(p) = raw[from..].find(open) {
            let pos = from + p;
            if best.map(|(bp, ..)| pos < bp).unwrap_or(true) {
                best = Some((pos, open.len(), i + 1));
            }
        }
    }
    best
}

/// Analyse linéaire du buffer brut en {visible, reasoning, tool_blocks}.
/// Un `<think>` ou un bloc d'outil non refermé en fin de buffer est traité
/// comme « en cours » : son contenu va respectivement en reasoning / en bloc
/// outil partiel (caché du visible). La marge HOLDBACK de l'appelant garantit
/// qu'on n'émet pas prématurément un tag coupé.
fn partition(raw: &str) -> Partition {
    let mut visible = String::new();
    let mut reasoning = String::new();
    let mut tool_blocks: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < raw.len() {
        match next_opener(raw, i) {
            None => {
                visible.push_str(&strip_leak_tokens(&raw[i..]));
                break;
            }
            Some((pos, open_len, kind)) => {
                visible.push_str(&strip_leak_tokens(&raw[i..pos]));
                let body_start = pos + open_len;
                if kind == 0 {
                    // <think> … </think>
                    if let Some(c) = raw[body_start..].find(THINK_CLOSE) {
                        reasoning.push_str(&raw[body_start..body_start + c]);
                        i = body_start + c + THINK_CLOSE.len();
                    } else {
                        reasoning.push_str(&raw[body_start..]); // think en cours
                        break;
                    }
                } else {
                    let close = TOOL_OPENERS[kind - 1].1;
                    if let Some(c) = raw[body_start..].find(close) {
                        tool_blocks.push(raw[body_start..body_start + c].to_string());
                        i = body_start + c + close.len();
                    } else {
                        // Bloc d'outil non refermé — on retient le partiel (caché).
                        tool_blocks.push(raw[body_start..].to_string());
                        break;
                    }
                }
            }
        }
    }
    Partition { visible, reasoning, tool_blocks }
}

/// Plus grand indice ≤ `target` qui est une frontière de caractère UTF-8.
fn floor_char_boundary(s: &str, target: usize) -> usize {
    let mut idx = target.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

impl MinimaxContentFilter {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Pousse un fragment de `delta.content`. Renvoie les deltas STABLES à
    /// émettre (la marge de fin est retenue jusqu'à ce qu'elle se stabilise
    /// ou jusqu'à `finish`).
    pub(crate) fn feed(&mut self, chunk: &str) -> FilterEmit {
        self.raw.push_str(chunk);
        self.recompute(false)
    }

    /// Fin de flux : vide toute la marge retenue.
    pub(crate) fn finish(&mut self) -> FilterEmit {
        self.recompute(true)
    }

    fn recompute(&mut self, flush: bool) -> FilterEmit {
        let Partition { visible, reasoning, tool_blocks } = partition(&self.raw);
        self.tool_blocks = tool_blocks;

        let vis_end = if flush {
            visible.len()
        } else {
            floor_char_boundary(&visible, visible.len().saturating_sub(HOLDBACK))
        };
        let rea_end = if flush {
            reasoning.len()
        } else {
            floor_char_boundary(&reasoning, reasoning.len().saturating_sub(HOLDBACK))
        };

        let mut emit = FilterEmit::default();
        if vis_end > self.emitted_visible {
            emit.visible = visible[self.emitted_visible..vis_end].to_string();
            self.emitted_visible = vis_end;
        }
        if rea_end > self.emitted_reasoning {
            emit.reasoning = reasoning[self.emitted_reasoning..rea_end].to_string();
            self.emitted_reasoning = rea_end;
        }
        emit
    }

    /// Nombre de blocs d'outils détectés (pour le delta de visibilité Lot 1).
    pub(crate) fn tool_block_count(&self) -> usize {
        self.tool_blocks.len()
    }

    /// Les blocs d'outils XML bruts (corps interne) — consommés par le Lot 2.
    pub(crate) fn tool_blocks(&self) -> &[String] {
        &self.tool_blocks
    }
}

// ────────────────────────────────────────────────────────────────────
// Parsing du corps d'un bloc d'outils MiniMax (XML natif)
// ────────────────────────────────────────────────────────────────────
//
// Un bloc (corps interne, hors <tool_call>/<minimax:tool_call>) contient un ou
// plusieurs :
//   <invoke name="NAME">
//     <parameter name="k">v</parameter>   (forme officielle M2)
//     <k>v</k>                              (forme courte observée M3)
//   </invoke>

/// Un appel d'outil extrait : nom + paires (clé, valeur brute).
pub(crate) struct ParsedInvoke {
    pub name: String,
    pub params: Vec<(String, String)>,
}

/// Extrait tous les `<invoke>` d'un ensemble de blocs, dans l'ordre. Tolérant
/// aux deux formes de paramètres et aux espaces. Pas de dépendance regex lourde
/// nécessaire ici : un scan linéaire suffit et reste lisible.
pub(crate) fn extract_invokes(blocks: &[String]) -> Vec<ParsedInvoke> {
    let mut out = Vec::new();
    for block in blocks {
        let mut rest = block.as_str();
        while let Some(start) = rest.find("<invoke") {
            // Sur tout `<invoke` malformé, on AVANCE d'un cran plutôt que
            // d'abandonner le reste du bloc (un invoke valide peut suivre).
            let advance = start + "<invoke".len();
            let after = &rest[start..];
            // Bornes : name="..." et le '>' fermant de la balise ouvrante.
            let open_gt = match after.find('>') {
                Some(g) => g,
                None => break, // pas de tag complet → rien d'exploitable après
            };
            let open_tag = &after[..open_gt]; // "<invoke name=\"...\"" (sans le >)
            let name = open_tag
                .find("name=\"")
                .map(|np| np + "name=\"".len())
                .and_then(|s| open_tag[s..].find('"').map(|e| open_tag[s..s + e].to_string()));
            let Some(name) = name else {
                rest = &rest[advance..];
                continue;
            };
            let body_start = start + open_gt + 1;
            let body_end = match rest[body_start..].find("</invoke>") {
                Some(e) => body_start + e,
                None => rest.len(),
            };
            let body = &rest[body_start..body_end];
            out.push(ParsedInvoke { name, params: extract_params(body) });
            // Avance après ce </invoke> (ou la fin).
            rest = if body_end + "</invoke>".len() <= rest.len() {
                &rest[body_end + "</invoke>".len()..]
            } else {
                ""
            };
        }
    }
    out
}

/// Extrait les paramètres du corps d'un `<invoke>` (les deux formes).
fn extract_params(body: &str) -> Vec<(String, String)> {
    let mut params = Vec::new();
    let mut rest = body;
    loop {
        // Forme officielle : <parameter name="k">v</parameter>
        if let Some(p) = rest.find("<parameter") {
            let after = &rest[p..];
            let mut matched = false;
            if let (Some(npos), Some(gt)) = (after.find("name=\""), after.find('>')) {
                let kvs = npos + "name=\"".len();
                if let Some(kve) = after[kvs..].find('"') {
                    let key = after[kvs..kvs + kve].to_string();
                    let vstart = p + gt + 1;
                    if let Some(ve) = rest[vstart..].find("</parameter>") {
                        params.push((key, rest[vstart..vstart + ve].trim().to_string()));
                        rest = &rest[vstart + ve + "</parameter>".len()..];
                        matched = true;
                    }
                }
            }
            if matched {
                continue;
            }
            // <parameter> malformé : on l'enjambe et on poursuit (des formes
            // courtes valides peuvent suivre) plutôt que d'abandonner.
            rest = &rest[p + "<parameter".len()..];
            continue;
        }
        // Forme courte : <k>v</k> (k ≠ invoke/parameter), première rencontrée.
        if let Some((key, val, end)) = next_short_tag(rest) {
            params.push((key, val));
            rest = &rest[end..];
            continue;
        }
        break;
    }
    params
}

/// Trouve le 1er `<tag>valeur</tag>` simple (nom alphanumérique), renvoie
/// (clé, valeur, position de fin dans `s`). Ignore `invoke`/`parameter`.
fn next_short_tag(s: &str) -> Option<(String, String, usize)> {
    let mut i = 0;
    while let Some(lt) = s[i..].find('<') {
        let abs = i + lt;
        let after = &s[abs + 1..];
        if after.starts_with('/') {
            i = abs + 1;
            continue;
        }
        // Lire le nom de tag.
        let name_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(after.len());
        let name = &after[..name_len];
        if name.is_empty() || name == "invoke" || name == "parameter" {
            i = abs + 1;
            continue;
        }
        // Doit être <name> (pas d'attributs pour la forme courte) puis </name>.
        let rest_after_name = &after[name_len..];
        let Some(gt) = rest_after_name.find('>') else { i = abs + 1; continue };
        let val_start = abs + 1 + name_len + gt + 1;
        let close = format!("</{name}>");
        if let Some(ce) = s[val_start..].find(&close) {
            let val = s[val_start..val_start + ce].trim().to_string();
            return Some((name.to_string(), val, val_start + ce + close.len()));
        }
        i = abs + 1;
    }
    None
}

/// Note de repli (Lot 1) quand le modèle n'a produit QUE des intentions
/// d'outils (pas de prose). Lisible, honnête sur l'état (exécution = Lot 2).
pub(crate) fn summarize_tool_blocks(blocks: &[String]) -> String {
    let invokes = extract_invokes(blocks);
    if invokes.is_empty() {
        return String::new();
    }
    let list = invokes
        .iter()
        .map(|inv| {
            let arg = inv
                .params
                .first()
                .map(|(_, v)| v.trim_matches(['"', '[', ']'].as_ref()).to_string())
                .unwrap_or_default();
            if arg.is_empty() {
                format!("`{}`", inv.name)
            } else {
                format!("`{}({})`", inv.name, arg)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "🔧 Shugu a voulu utiliser des outils : {list}.\n\n\
         _L'exécution des outils directement dans le chat arrive très bientôt. \
         En attendant, active « Accès complet » puis relance, ou passe par le panneau Agents._"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pousse tout d'un coup puis finish — agrège visible + reasoning.
    fn run_once(raw: &str) -> (String, String, usize) {
        let mut f = MinimaxContentFilter::new();
        let a = f.feed(raw);
        let b = f.finish();
        (
            a.visible + &b.visible,
            a.reasoning + &b.reasoning,
            f.tool_block_count(),
        )
    }

    /// Pousse caractère par caractère (pire cas de coupure) puis finish.
    fn run_streamed(raw: &str) -> (String, String, usize) {
        let mut f = MinimaxContentFilter::new();
        let mut vis = String::new();
        let mut rea = String::new();
        for ch in raw.chars() {
            let mut buf = [0u8; 4];
            let e = f.feed(ch.encode_utf8(&mut buf));
            vis.push_str(&e.visible);
            rea.push_str(&e.reasoning);
        }
        let e = f.finish();
        vis.push_str(&e.visible);
        rea.push_str(&e.reasoning);
        (vis, rea, f.tool_block_count())
    }

    #[test]
    fn plain_text_is_noop() {
        let (v, r, t) = run_once("Bonjour, voici la réponse.");
        assert_eq!(v, "Bonjour, voici la réponse.");
        assert_eq!(r, "");
        assert_eq!(t, 0);
    }

    #[test]
    fn plain_text_noop_streamed_charwise() {
        // Garantit l'absence de perte/retenue sur du texte propre (UTF-8 inclus).
        let s = "Réponse en plusieurs mots — accents éàç ok.";
        let (v, r, t) = run_streamed(s);
        assert_eq!(v, s);
        assert_eq!(r, "");
        assert_eq!(t, 0);
    }

    #[test]
    fn extracts_think_to_reasoning() {
        let (v, r, _) = run_once("<think>je réfléchis ici</think>Voici la réponse.");
        assert_eq!(v, "Voici la réponse.");
        assert_eq!(r, "je réfléchis ici");
    }

    #[test]
    fn think_split_across_chunks_charwise() {
        let (v, r, _) = run_streamed("avant<think>caché</think>après");
        assert_eq!(v, "avantaprès");
        assert_eq!(r, "caché");
    }

    #[test]
    fn unclosed_think_goes_to_reasoning() {
        let (v, r, _) = run_once("<think>raisonnement non terminé");
        assert_eq!(v, "");
        assert_eq!(r, "raisonnement non terminé");
    }

    #[test]
    fn suppresses_tool_block_and_strips_leak_tokens() {
        // Reproduit la capture d'écran : <think> + jetons qui fuient + tool XML.
        let raw = "<think>OK je vérifie</think>\n\
                   ]<]minimax[>[<tool_call>\n\
                   ]<]minimax[>[<invoke name=\"fs_list_dir\">]<]minimax[>[<path>js</path>\n\
                   </invoke>\n\
                   </tool_call>";
        let (v, r, t) = run_once(raw);
        assert_eq!(r, "OK je vérifie");
        assert_eq!(t, 1);
        // Le corps visible ne doit contenir NI le XML d'outil NI les jetons.
        assert!(!v.contains("tool_call"), "visible leaked tool XML: {v:?}");
        assert!(!v.contains("invoke"), "visible leaked invoke: {v:?}");
        assert!(!v.contains("]<]minimax"), "visible leaked token: {v:?}");
    }

    #[test]
    fn tool_block_split_across_chunks_charwise() {
        let raw = "txt<minimax:tool_call><invoke name=\"x\"></invoke></minimax:tool_call>end";
        let (v, r, t) = run_streamed(raw);
        assert_eq!(v, "txtend");
        assert_eq!(r, "");
        assert_eq!(t, 1);
    }

    #[test]
    fn captures_tool_block_body_for_lot2() {
        let raw = "<tool_call><invoke name=\"fs_read_file\"><path>a.ts</path></invoke></tool_call>";
        let mut f = MinimaxContentFilter::new();
        f.feed(raw);
        f.finish();
        assert_eq!(f.tool_block_count(), 1);
        let body = &f.tool_blocks()[0];
        assert!(body.contains("fs_read_file"));
        assert!(body.contains("a.ts"));
        assert!(!body.contains("<tool_call>"));
    }

    #[test]
    fn multiple_tool_blocks() {
        let raw = "<tool_call>A</tool_call> entre <tool_call>B</tool_call>";
        let (v, _, t) = run_once(raw);
        assert_eq!(t, 2);
        assert!(v.contains("entre"));
        assert!(!v.contains("tool_call"));
    }

    #[test]
    fn leak_token_split_across_chunks_not_emitted() {
        // Le jeton ]<]minimax[>[ coupé en deux ne doit jamais fuir.
        let (v, _, _) = run_streamed("a]<]minimax[>[b");
        assert_eq!(v, "ab");
    }

    // ── Extraction des invokes ────────────────────────────────────────
    #[test]
    fn extract_invokes_short_form() {
        // Forme courte <path>v</path> (capture d'écran M3).
        let blocks = vec![
            "<invoke name=\"fs_list_dir\"><path>js</path></invoke>\
             <invoke name=\"fs_read_file\"><path>formicium.html</path></invoke>"
                .to_string(),
        ];
        let inv = extract_invokes(&blocks);
        assert_eq!(inv.len(), 2);
        assert_eq!(inv[0].name, "fs_list_dir");
        assert_eq!(inv[0].params, vec![("path".to_string(), "js".to_string())]);
        assert_eq!(inv[1].name, "fs_read_file");
        assert_eq!(inv[1].params, vec![("path".to_string(), "formicium.html".to_string())]);
    }

    #[test]
    fn extract_invokes_official_parameter_form() {
        let blocks = vec![
            "<invoke name=\"search_web\"><parameter name=\"query\">rust async</parameter></invoke>"
                .to_string(),
        ];
        let inv = extract_invokes(&blocks);
        assert_eq!(inv.len(), 1);
        assert_eq!(inv[0].name, "search_web");
        assert_eq!(inv[0].params, vec![("query".to_string(), "rust async".to_string())]);
    }

    #[test]
    fn malformed_invoke_without_name_is_skipped_not_abandoned() {
        // Un <invoke> sans name= ne doit pas faire perdre l'invoke valide
        // qui suit (ni boucler). Robustesse de revue.
        let blocks = vec![
            "<invoke><path>x</path></invoke>\
             <invoke name=\"fs_read_file\"><path>ok.ts</path></invoke>"
                .to_string(),
        ];
        let inv = extract_invokes(&blocks);
        assert_eq!(inv.len(), 1);
        assert_eq!(inv[0].name, "fs_read_file");
        assert_eq!(inv[0].params, vec![("path".to_string(), "ok.ts".to_string())]);
    }

    #[test]
    fn mixed_parameter_and_short_form_both_extracted() {
        let blocks = vec![
            "<invoke name=\"t\"><parameter name=\"a\">1</parameter><b>2</b></invoke>".to_string(),
        ];
        let inv = extract_invokes(&blocks);
        assert_eq!(inv.len(), 1);
        assert_eq!(
            inv[0].params,
            vec![("a".to_string(), "1".to_string()), ("b".to_string(), "2".to_string())]
        );
    }

    #[test]
    fn summarize_reads_names_and_first_arg() {
        let blocks = vec![
            "<invoke name=\"fs_list_dir\"><path>js</path></invoke>\
             <invoke name=\"fs_read_file\"><path>formicium.html</path></invoke>"
                .to_string(),
        ];
        let s = summarize_tool_blocks(&blocks);
        assert!(s.contains("`fs_list_dir(js)`"), "{s}");
        assert!(s.contains("`fs_read_file(formicium.html)`"), "{s}");
    }
}
