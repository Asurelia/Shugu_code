//! Capacités par modèle — SOURCE DE VÉRITÉ UNIQUE (Rust) du tiering.
//!
//! Calqué sur le style de `search::model_supports_native_search` : on matche
//! sur (protocole, NOM du modèle) — jamais le protocole seul, car MiniMax,
//! Mistral, Groq et llama.cpp arrivent TOUS au dispatcher en `protocol="openai"`
//! (cf. `providers.ts` PROVIDER_REGISTRY). Le signal de famille vit dans la
//! chaîne du modèle.
//!
//! Doctrine : concevoir pour le modèle FORT, dégrader gracieusement vers le
//! PETIT derrière ce flag. Un modèle inconnu / custom retombe sur le côté SÛR
//! (Strong + Full) — on ne bride jamais un modèle capable par erreur ; le tier
//! Small est l'exception explicite, pas le défaut.
//!
//! Pièges de sous-chaîne traités : `"minimax"` contient `"mini"` (→ on exige
//! `-mini`) ; `"32b"` contient `"2b"` (→ on teste « large » d'abord et on ne
//! retient `small` que si `!large`).

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Strong,
    Small,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Toolset {
    Full,
    Reduced,
}

/// Instantané des capacités d'un modèle. Tous les champs ont une valeur sûre par
/// défaut (jamais d'option « en cours de chargement » à gérer côté consommateur).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub tier: Tier,
    /// Off-switch AU NIVEAU MODÈLE pour la boucle d'outils (en plus du gate par
    /// protocole). `false` uniquement pour les modèles vraiment minuscules,
    /// incapables de tool-calling fiable → on retombe sur le single-call.
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub context_window: u32,
    pub recommended_toolset: Toolset,
}

/// Marqueurs de NOM pour les GROS modèles locaux qui tool-callent correctement
/// (≥ ~30B). Testé EN PREMIER pour neutraliser le piège « 32b contient 2b ».
fn name_is_large(m: &str) -> bool {
    m.contains("32b")
        || m.contains("34b")
        || m.contains("65b")
        || m.contains("70b")
        || m.contains("72b")
        || m.contains("405b")
        || m.contains("a3b") // MoE large (ex. Qwen3-235B-A22B / 30B-A3B)
        || m.contains("235b")
        || m.contains("253b")
}

/// Comptes de paramètres ≤ ~14B (à coupler avec `!name_is_large`).
fn has_small_param_count(m: &str) -> bool {
    m.contains("1b")
        || m.contains("2b")
        || m.contains("3b")
        || m.contains("4b")
        || m.contains("7b")
        || m.contains("8b")
        || m.contains("9b")
        || m.contains("13b")
        || m.contains("14b")
}

/// Marqueurs de NOM pour les PETITS modèles (tool-calling faible). On exige
/// `-mini` (et non `mini`) pour ne PAS attraper `minimax`.
fn name_is_small(m: &str) -> bool {
    m.contains("-mini")
        || m.contains("mini-")
        || m.ends_with("mini")
        || m.contains("-small")
        || m.contains("gemma")
        || m.contains("phi-")
        || m.contains("phi3")
        || m.contains("phi4")
        || has_small_param_count(m)
}

/// Marqueur de taille `tag` (ex. "3b") présent ET NON précédé d'un chiffre →
/// évite que « 13b » ⊃ « 3b » ou « 21b » ⊃ « 1b » ne fasse passer un 13B/21B
/// pour un modèle minuscule.
fn bounded_size(m: &str, tag: &str) -> bool {
    m.match_indices(tag).any(|(i, _)| {
        i == 0
            || !matches!(
                m.as_bytes().get(i - 1).copied(),
                Some(b'0'..=b'9')
            )
    })
}

/// « Tiny » = trop faible pour tout tool-calling fiable → single-call. Délimité
/// (cf. `bounded_size`) : seuls 1B/2B/3B autonomes comptent, pas 13B/21B/33B.
fn name_is_tiny(m: &str) -> bool {
    bounded_size(m, "1b") || bounded_size(m, "2b") || bounded_size(m, "3b")
}

/// Heuristique vision (NON câblée à l'enforcement en v1 — le chemin
/// `attached_image` gère déjà la vision ; sert au badge UI + au futur).
fn name_has_vision(m: &str) -> bool {
    m.contains("opus-4")
        || m.contains("sonnet-4")
        || m.contains("haiku-4")
        || m.contains("claude-4")
        || m.contains("fable")
        || m.contains("gpt-4o")
        || m.contains("gpt-4.1")
        || m.contains("gpt-5")
        || m.contains("-vl")
        || m.contains("vision")
}

/// Fenêtre de contexte (tokens). Défaut côté FORT = large (pas de régression de
/// compaction sur cloud/custom) ; seuls les petits modèles obtiennent une petite
/// fenêtre → compaction plus précoce. Indices explicites (`128k`/`32k`) honorés.
/// Valeurs des familles cloud VÉRIFIÉES vs sources officielles (docs Anthropic /
/// OpenAI, model cards MiniMax) — sous-estimer ne provoque jamais d'overflow, mais
/// gaspille la fenêtre, d'où les corrections nommées ci-dessous.
fn context_window_for(protocol: &str, m: &str, tier: Tier) -> u32 {
    if protocol == "anthropic" {
        // Opus 4.6/4.7/4.8 et Sonnet 4.6 embarquent une fenêtre 1M ; les familles
        // Claude antérieures (Opus 4/4.1, Sonnet 4, Haiku 3.5/4.5) restent à 200k.
        // Le défaut du repo `claude-opus-4-8` EST 1M — ne pas le brider à 200k
        // (sinon compaction ~5× trop tôt).
        if m.contains("opus-4-6")
            || m.contains("opus-4-7")
            || m.contains("opus-4-8")
            || m.contains("sonnet-4-6")
        {
            return 1_000_000;
        }
        return 200_000;
    }
    // Marqueurs de taille explicites dans le nom (honorés en premier).
    if m.contains("1m") || m.contains("1000k") {
        return 1_000_000;
    }
    if m.contains("200k") {
        return 200_000;
    }
    if m.contains("128k") {
        return 131_072;
    }
    if m.contains("64k") {
        return 65_536;
    }
    if m.contains("32k") {
        return 32_768;
    }
    // Familles cloud à grande fenêtre dont le nom ne porte pas de marqueur de
    // taille (vérifié vs officiel) : MiniMax (Text-01 / M1 = 1M) et GPT-4.1
    // (+ mini/nano = 1M, contrairement à GPT-4o qui reste à 128k).
    if m.contains("minimax") || m.contains("gpt-4.1") {
        return 1_000_000;
    }
    match tier {
        // cloud/custom fort, fenêtre inconnue → on suppose large (128k).
        Tier::Strong => 128_000,
        // petit (local ou cloud faible), fenêtre inconnue → prudent (8k, protège
        // de l'overflow).
        Tier::Small => 8_192,
    }
}

/// Capacités d'un modèle à partir de (protocole, nom). Pure et déterministe →
/// testable et utilisable côté UI via la commande Tauri.
pub fn capabilities(protocol: &str, model: &str) -> ModelCapabilities {
    let m = model.to_ascii_lowercase();
    let large = name_is_large(&m);
    let small_name = name_is_small(&m) && !large;
    let tiny = name_is_tiny(&m) && !large;

    let tier = match protocol {
        // ollama est un protocole distinct (local) → défaut Small sauf gros modèle.
        "ollama" => {
            if large {
                Tier::Strong
            } else {
                Tier::Small
            }
        }
        // cloud + custom (et llama.cpp qui arrive en "openai") → défaut Strong,
        // rétrogradé seulement sur un nom explicitement petit.
        _ => {
            if small_name {
                Tier::Small
            } else {
                Tier::Strong
            }
        }
    };

    let recommended_toolset = if matches!(tier, Tier::Small) {
        Toolset::Reduced
    } else {
        Toolset::Full
    };

    ModelCapabilities {
        tier,
        supports_tools: !tiny,
        supports_vision: name_has_vision(&m),
        context_window: context_window_for(protocol, &m, tier),
        recommended_toolset,
    }
}

// `context_window` (ci-dessus) est désormais la fenêtre consommée DIRECTEMENT par
// la compaction token-aware du runner (budget de tokens, cf.
// `agents::runner::resolve_context_window`) — l'ancien helper `compaction_trigger`
// (seuil EN TOURS dérivé de la fenêtre) a été retiré : le déclencheur n'est plus
// un compteur de tours.

/// Un modèle peut-il piloter une DÉLÉGATION (orchestration multi-agent fiable :
/// l'outil `delegate` qui spawn un sous-agent à contexte isolé) ? Conservateur
/// comme `search::model_supports_native_search` : seuls les modèles à tool-use
/// robuste + raisonnement long le voient. Volontairement restrictif (un modèle
/// faible qui fumble une délégation gâche un sous-run entier). Élargissable.
pub fn model_supports_delegation(protocol: &str, model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    match protocol {
        "anthropic" => {
            m.contains("opus-4")
                || m.contains("sonnet-4")
                || m.contains("claude-4")
                || m.contains("fable")
        }
        // GPT-5 / o-series / GPT-4.1 + MiniMax M2/M3 (provider built-in, capable),
        // SAUF les variantes « -mini ». NB : on exclut « -mini » (et non « mini »)
        // pour ne PAS écarter « minimax » qui contient « mini ».
        "openai" | "custom" => {
            let capable = m.contains("gpt-5")
                || m.contains("o3")
                || m.contains("o4")
                || m.contains("gpt-4.1")
                || m.contains("minimax");
            capable && !m.contains("-mini")
        }
        _ => false,
    }
}

/// Outils « core » conservés pour les petits modèles (toolset réduit). Exclut
/// web_*, code_search, advisor, skill_save, todo_write, capture_screen et les
/// outils MCP namespacés (`mcp__…`) — un petit modèle se noie dans un gros set.
pub fn is_core_small_tool(name: &str) -> bool {
    matches!(
        name,
        "fs_read_file" | "fs_list_dir" | "fs_search" | "fs_write_file" | "fs_edit" | "run_command"
    )
}

/// Fragment de prompt système ajouté SELON le palier du modèle. Pendant logique
/// de `is_core_small_tool` : on conçoit pour le modèle FORT (prompt de base
/// inchangé → `None`) et on DÉGRADE pour le PETIT en lui ajoutant des consignes
/// directives, cohérentes avec le toolset déjà réduit. `has_tools` distingue une
/// boucle outillée (agent / chat-tool-loop) d'un appel chat sans outils — un
/// petit modèle sans outils (ollama agent, tiny, single-call) reçoit la variante
/// « plain » qui ne mentionne aucun outil. Le fragment est inséré comme message
/// `role:"system"` séparé (donc PAS de `\n\n` en tête) ; il est hoisté/joint avec
/// les autres blocs système en aval.
pub fn tier_prompt(tier: Tier, has_tools: bool) -> Option<&'static str> {
    match (tier, has_tools) {
        (Tier::Strong, _) => None,
        (Tier::Small, true) => Some(SMALL_TIER_PROMPT_TOOLS),
        (Tier::Small, false) => Some(SMALL_TIER_PROMPT_PLAIN),
    }
}

/// Consignes pour un petit modèle DANS une boucle outillée. Les outils nommés
/// reflètent exactement la whitelist `is_core_small_tool`.
const SMALL_TIER_PROMPT_TOOLS: &str = "You are running as a smaller model. Work in small, verifiable steps:\n\
- Call ONE tool at a time, then read its result before deciding the next step.\n\
- Only the core tools exist (fs_read_file, fs_list_dir, fs_search, fs_write_file, fs_edit, run_command). Do not assume others.\n\
- Keep each action tightly scoped; prefer the smallest change that makes progress.\n\
- After each tool result, restate in one line what you learned and what you'll do next.\n\
- If the task is too large to do reliably in one pass, ask for a smaller, more specific instruction instead of guessing.\n\
- Do not fabricate file contents or command output; rely only on what tools return.";

/// Consignes pour un petit modèle SANS outils (chat single-call). Ne mentionne
/// aucun outil.
const SMALL_TIER_PROMPT_PLAIN: &str = "You are running as a smaller model. Keep your answer focused and concrete:\n\
- Address only what was asked; do not pad with unrelated detail.\n\
- Prefer short, direct steps over long reasoning chains.\n\
- If the request is ambiguous or too broad, ask one clarifying question instead of guessing.\n\
- State only what you are confident about; do not invent facts.";

/// Commande Tauri d'exposition à l'UI (badges du sélecteur de modèle).
/// L'enforcement (gating outils/contexte) reste côté Rust ; le TS n'appelle
/// ceci que pour AFFICHER.
#[tauri::command]
pub fn model_capabilities(protocol: String, model: String) -> ModelCapabilities {
    capabilities(&protocol, &model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_cloud_models_are_strong_full_tools() {
        for (p, m) in [
            ("anthropic", "claude-opus-4-8"),
            ("anthropic", "claude-sonnet-4-6"),
            ("anthropic", "claude-haiku-4-5"),
            ("anthropic", "claude-fable-5"),
            ("openai", "gpt-5"),
            ("openai", "gpt-4o"),
        ] {
            let c = capabilities(p, m);
            assert_eq!(c.tier, Tier::Strong, "{m} should be Strong");
            assert_eq!(c.recommended_toolset, Toolset::Full, "{m} should be Full");
            assert!(c.supports_tools, "{m} should support tools");
        }
    }

    #[test]
    fn gpt_4o_mini_is_small_despite_cloud() {
        let c = capabilities("openai", "gpt-4o-mini");
        assert_eq!(c.tier, Tier::Small);
        assert_eq!(c.recommended_toolset, Toolset::Reduced);
        assert!(c.supports_tools, "mini can still tool-call, just reduced set");
    }

    #[test]
    fn minimax_is_not_caught_by_mini_substring() {
        // "minimax" contient "mini" — ne doit PAS être classé Small.
        let c = capabilities("openai", "MiniMax-M2");
        assert_eq!(c.tier, Tier::Strong, "MiniMax must stay Strong");
    }

    #[test]
    fn size_32b_not_caught_by_2b_substring() {
        // "32b" contient "2b" — doit rester Strong (gros modèle).
        let c = capabilities("ollama", "qwen2.5:32b");
        assert_eq!(c.tier, Tier::Strong);
        let c2 = capabilities("openai", "qwen2.5-72b-instruct");
        assert_eq!(c2.tier, Tier::Strong);
    }

    #[test]
    fn small_local_models_are_small_reduced() {
        for m in ["qwen2.5:7b", "llama3.1:8b", "mistral:7b"] {
            let c = capabilities("ollama", m);
            assert_eq!(c.tier, Tier::Small, "{m} should be Small");
            assert_eq!(c.recommended_toolset, Toolset::Reduced);
            assert!(c.context_window <= 16_384, "{m} small window");
        }
    }

    #[test]
    fn tiny_models_drop_tool_support() {
        let c = capabilities("ollama", "gemma:2b");
        assert_eq!(c.tier, Tier::Small);
        assert!(!c.supports_tools, "2b is too tiny for reliable tool-calling");
    }

    #[test]
    fn mid_size_models_are_small_but_keep_tools() {
        // "13b" contient "3b", "21b" contient "1b" — ne doivent PAS être classés
        // tiny (sinon perte SILENCIEUSE des outils en chat). Ils restent Small
        // (toolset réduit) mais GARDENT supports_tools.
        for m in ["llama-2-13b", "codellama:13b", "some-21b-model"] {
            let c = capabilities("openai", m);
            assert_eq!(c.tier, Tier::Small, "{m} should be Small");
            assert!(c.supports_tools, "{m} (mid-size) must keep tool support");
        }
    }

    #[test]
    fn unknown_custom_defaults_safe_strong() {
        let c = capabilities("custom", "some-unknown-frontier-model");
        assert_eq!(c.tier, Tier::Strong, "unknown → safe default Strong");
        assert_eq!(c.recommended_toolset, Toolset::Full);
        assert!(c.supports_tools);
        assert!(c.context_window > 65_536, "unknown strong keeps a large context window");
    }

    #[test]
    fn delegation_gate_is_conservative() {
        assert!(model_supports_delegation("anthropic", "claude-opus-4-8"));
        assert!(model_supports_delegation("anthropic", "claude-sonnet-4-6"));
        assert!(model_supports_delegation("openai", "gpt-5"));
        assert!(model_supports_delegation("openai", "MiniMax-M2"));
        // Refusés : petits / anciens / mini.
        assert!(!model_supports_delegation("openai", "gpt-4o-mini"));
        assert!(!model_supports_delegation("openai", "gpt-5-mini"));
        assert!(!model_supports_delegation("anthropic", "claude-3-5-sonnet"));
        assert!(!model_supports_delegation("ollama", "qwen2.5:7b"));
        assert!(!model_supports_delegation("ollama", "qwen2.5:72b"));
    }

    #[test]
    fn context_window_values_match_official_sizes() {
        let w = |p: &str, m: &str| capabilities(p, m).context_window;
        // Claude : Opus 4.6/4.7/4.8 + Sonnet 4.6 = 1M (dont le défaut repo
        // claude-opus-4-8) ; familles antérieures = 200k (discrimination de version).
        assert_eq!(w("anthropic", "claude-opus-4-8"), 1_000_000);
        assert_eq!(w("anthropic", "claude-sonnet-4-6"), 1_000_000);
        assert_eq!(w("anthropic", "claude-opus-4-1"), 200_000);
        assert_eq!(w("anthropic", "claude-sonnet-4"), 200_000);
        assert_eq!(w("anthropic", "claude-haiku-4-5"), 200_000);
        // MiniMax (Text-01 / M1) = 1M malgré l'absence de marqueur de taille.
        assert_eq!(w("openai", "MiniMax-M1"), 1_000_000);
        assert_eq!(w("openai", "MiniMax-Text-01"), 1_000_000);
        // GPT-4.1 (+ mini) = 1M ; GPT-4o reste à 128k.
        assert_eq!(w("openai", "gpt-4.1"), 1_000_000);
        assert_eq!(w("openai", "gpt-4.1-mini"), 1_000_000);
        assert_eq!(w("openai", "gpt-4o"), 128_000);
        // Marqueur explicite dans le nom honoré.
        assert_eq!(w("openai", "some-model-32k"), 32_768);
    }

    #[test]
    fn core_small_tools_whitelist() {
        assert!(is_core_small_tool("fs_read_file"));
        assert!(is_core_small_tool("run_command"));
        assert!(!is_core_small_tool("code_search"));
        assert!(!is_core_small_tool("advisor"));
        assert!(!is_core_small_tool("web_search"));
        assert!(!is_core_small_tool("mcp__fs__read_file"));
    }

    #[test]
    fn strong_tier_gets_no_prompt_fragment() {
        // Doctrine : le prompt de base EST taillé pour le fort → aucun ajout,
        // quel que soit l'état des outils. Additif, jamais de régression.
        assert_eq!(tier_prompt(Tier::Strong, true), None);
        assert_eq!(tier_prompt(Tier::Strong, false), None);
    }

    #[test]
    fn small_tier_with_tools_names_the_core_tools() {
        let frag = tier_prompt(Tier::Small, true).expect("small+tools → fragment");
        // Mentionne au moins un outil core et cadre l'usage outil à la fois.
        assert!(frag.contains("fs_read_file"), "tools fragment should name core tools");
        assert!(frag.contains("ONE tool at a time"));
    }

    #[test]
    fn small_tier_without_tools_mentions_no_tool() {
        let frag = tier_prompt(Tier::Small, false).expect("small+no-tools → fragment");
        // La variante « plain » ne doit nommer AUCUN outil (chat sans outils).
        for tool in ["fs_read_file", "fs_edit", "run_command", "tool"] {
            assert!(
                !frag.contains(tool),
                "plain fragment must not mention `{tool}` (no tools available)"
            );
        }
    }
}
