// Shugu Forge — Task-graph d'orchestration (LOT 1).
//
// Promeut `todo_write` d'un no-op advisory à un VRAI graphe de tâches
// dependency-aware qui :
//   (a) se valide — ids dupliqués, dépendances vers un id inconnu, cycles ;
//   (b) calcule la PROCHAINE tâche actionnable (toutes dépendances satisfaites) ;
//   (c) se ré-injecte dans le contexte du modèle après chaque mise à jour pour
//       ANCRER la boucle sur le graphe (façon deep-agents / APEX), même une fois
//       que la compaction a replié l'appel `todo_write` d'origine.
//
// Pas de nouvelle table : le graphe vit dans les args du toolCall `todo_write`,
// déjà persistés dans `agent_events` (source de vérité de l'UI). Ce module ne
// fait QUE de la logique pure sur ces args — aucune I/O — donc testable en
// isolation, comme `plan_compaction_cut` dans runner.rs.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// État d'une tâche. Trois états façon Claude Code (☐/◐/☑) ; « bloqué » n'est PAS
/// un état stocké mais une propriété DÉRIVÉE (dépendances non terminées).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl TaskStatus {
    fn parse(s: &str) -> Self {
        match s {
            "in_progress" => TaskStatus::InProgress,
            "completed" => TaskStatus::Completed,
            _ => TaskStatus::Pending,
        }
    }

    fn glyph(self) -> char {
        match self {
            TaskStatus::Completed => '☑',
            TaskStatus::InProgress => '◐',
            TaskStatus::Pending => '☐',
        }
    }
}

/// Un nœud du graphe. `id` est stable (fourni par le modèle, ou auto-assigné
/// `T1..` sur l'index d'origine pour rester stable entre deux envois).
#[derive(Clone, Debug)]
pub(super) struct TaskNode {
    id: String,
    text: String,
    status: TaskStatus,
    depends_on: Vec<String>,
    done_when: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct TaskGraph {
    nodes: Vec<TaskNode>,
}

impl TaskGraph {
    /// Parse le champ `todos` des args de `todo_write`. Saute les étapes sans
    /// texte (vides de sens) mais garde l'index d'ORIGINE pour l'auto-id afin
    /// que les ids restent stables si une étape devient temporairement vide.
    /// Retourne `None` si aucune tâche valide (pas de liste, ou toutes vides) —
    /// le caller traite ça comme « pas de plan posé ».
    pub(super) fn parse(args: &Value) -> Option<TaskGraph> {
        let arr = args.get("todos")?.as_array()?;
        let mut nodes = Vec::with_capacity(arr.len());
        for (i, item) in arr.iter().enumerate() {
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }
            let status = TaskStatus::parse(
                item.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending"),
            );
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("T{}", i + 1));
            let depends_on = item
                .get("depends_on")
                .and_then(Value::as_array)
                .map(|d| {
                    d.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let done_when = item
                .get("done_when")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            nodes.push(TaskNode {
                id,
                text,
                status,
                depends_on,
                done_when,
            });
        }
        if nodes.is_empty() {
            None
        } else {
            Some(TaskGraph { nodes })
        }
    }

    fn done_ids(&self) -> HashSet<&str> {
        self.nodes
            .iter()
            .filter(|n| n.status == TaskStatus::Completed)
            .map(|n| n.id.as_str())
            .collect()
    }

    /// Une tâche non terminée dont AU MOINS une dépendance n'est pas terminée.
    fn is_blocked(node: &TaskNode, done: &HashSet<&str>) -> bool {
        node.status != TaskStatus::Completed
            && node.depends_on.iter().any(|d| !done.contains(d.as_str()))
    }

    /// La prochaine tâche sur laquelle agir : une tâche déjà `in_progress` et
    /// débloquée en priorité, sinon la première `pending` débloquée. `None` si
    /// tout est terminé OU si tout le reste est bloqué (deps non satisfaites /
    /// cycle).
    pub(super) fn next_actionable(&self) -> Option<&TaskNode> {
        let done = self.done_ids();
        self.nodes
            .iter()
            .find(|n| n.status == TaskStatus::InProgress && !Self::is_blocked(n, &done))
            .or_else(|| {
                self.nodes
                    .iter()
                    .find(|n| n.status == TaskStatus::Pending && !Self::is_blocked(n, &done))
            })
    }

    /// Avertissements NON bloquants : ids dupliqués, dépendances vers un id
    /// inconnu, cycles. Le modèle les lit dans l'accusé et se corrige de
    /// lui-même — on ne renvoie jamais d'erreur dure (le plan reste advisory
    /// dans sa forme, exécutable dans son ancrage).
    pub(super) fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();

        let mut seen: HashSet<&str> = HashSet::new();
        for n in &self.nodes {
            if !seen.insert(n.id.as_str()) {
                w.push(format!("id dupliqué : {}", n.id));
            }
        }

        let known: HashSet<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
        for n in &self.nodes {
            for d in &n.depends_on {
                if !known.contains(d.as_str()) {
                    w.push(format!("{} dépend de {d} (id inconnu)", n.id));
                }
            }
        }

        if let Some(cycle) = self.find_cycle() {
            w.push(format!("cycle de dépendances : {}", cycle.join(" → ")));
        }
        w
    }

    /// Détection de cycle par DFS coloré (blanc/gris/noir). Retourne le chemin
    /// du cycle si présent. Graphe petit (< quelques dizaines de nœuds) → on
    /// clone les ids pour garder des lifetimes simples.
    fn find_cycle(&self) -> Option<Vec<String>> {
        #[derive(Clone, Copy, PartialEq)]
        enum Color {
            White,
            Gray,
            Black,
        }

        fn dfs(
            id: &str,
            deps: &HashMap<String, Vec<String>>,
            color: &mut HashMap<String, Color>,
            path: &mut Vec<String>,
        ) -> Option<Vec<String>> {
            color.insert(id.to_string(), Color::Gray);
            path.push(id.to_string());
            if let Some(children) = deps.get(id) {
                for d in children {
                    match color.get(d).copied().unwrap_or(Color::White) {
                        Color::Gray => {
                            // Cycle : du premier passage sur `d` dans la pile jusqu'au bout.
                            let start = path.iter().position(|x| x == d).unwrap_or(0);
                            let mut cyc = path[start..].to_vec();
                            cyc.push(d.clone());
                            return Some(cyc);
                        }
                        Color::White if deps.contains_key(d) => {
                            if let Some(c) = dfs(d, deps, color, path) {
                                return Some(c);
                            }
                        }
                        // Dépendance inconnue (pas dans `deps`) : signalée par `warnings`,
                        // pas un cycle. Noir : déjà exploré.
                        _ => {}
                    }
                }
            }
            path.pop();
            color.insert(id.to_string(), Color::Black);
            None
        }

        let mut deps: HashMap<String, Vec<String>> = HashMap::new();
        for n in &self.nodes {
            deps.entry(n.id.clone())
                .or_default()
                .extend(n.depends_on.iter().cloned());
        }
        let mut color: HashMap<String, Color> =
            deps.keys().map(|k| (k.clone(), Color::White)).collect();
        let mut path: Vec<String> = Vec::new();

        let ids: Vec<String> = self.nodes.iter().map(|n| n.id.clone()).collect();
        for id in ids {
            if color.get(&id).copied().unwrap_or(Color::White) == Color::White {
                if let Some(c) = dfs(&id, &deps, &mut color, &mut path) {
                    return Some(c);
                }
                path.clear();
            }
        }
        None
    }

    fn counts(&self) -> (usize, usize) {
        let done = self
            .nodes
            .iter()
            .filter(|n| n.status == TaskStatus::Completed)
            .count();
        (done, self.nodes.len())
    }

    /// Accusé de réception renvoyé au modèle quand il appelle `todo_write` :
    /// confirme l'état + la prochaine tâche + les avertissements éventuels.
    /// Remplace l'ancien « recorded N todo(s) » (no-op) par un retour qui PILOTE
    /// la suite (le modèle sait quoi faire ensuite).
    pub(super) fn ack(&self) -> String {
        let (done, total) = self.counts();
        let mut s = format!("plan enregistré : {done}/{total} terminé(s)");
        if let Some(n) = self.next_actionable() {
            s.push_str(&format!(" · prochaine : {} — {}", n.id, n.text));
        } else if done == total {
            s.push_str(" · ✅ toutes les tâches sont terminées");
        } else {
            s.push_str(" · ⚠ aucune tâche actionnable (dépendances non satisfaites ou cycle)");
        }
        let w = self.warnings();
        if !w.is_empty() {
            s.push_str(&format!(" · ⚠ {}", w.join(" ; ")));
        }
        s
    }

    /// Bloc compact ré-injecté dans le contexte après chaque mise à jour du plan
    /// — c'est l'ANCRAGE qui rend le graphe « exécutable » : le modèle revoit son
    /// plan + ce qui est bloqué + la prochaine action à chaque tour utile, même
    /// après compaction.
    pub(super) fn reminder_block(&self) -> String {
        let done = self.done_ids();
        let mut lines = Vec::with_capacity(self.nodes.len() + 1);
        for n in &self.nodes {
            let mut line = format!("{} {} {}", n.status.glyph(), n.id, n.text);
            if !n.depends_on.is_empty() {
                line.push_str(&format!(" (après {})", n.depends_on.join(", ")));
            }
            if Self::is_blocked(n, &done) {
                line.push_str(" [bloqué]");
            }
            lines.push(line);
        }
        if let Some(n) = self.next_actionable() {
            let mut next = format!("→ prochaine action : {} — {}", n.id, n.text);
            if let Some(dw) = &n.done_when {
                next.push_str(&format!(" (fini quand : {dw})"));
            }
            lines.push(next);
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph(v: Value) -> TaskGraph {
        TaskGraph::parse(&v).expect("graphe valide attendu")
    }

    #[test]
    fn parse_assigns_ids_and_skips_textless() {
        let g = graph(json!({"todos": [
            {"text": "a", "status": "completed"},
            {"text": "", "status": "pending"},
            {"text": "b", "status": "pending"}
        ]}));
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.nodes[0].id, "T1");
        // L'étape vide (index 1) est sautée ; "b" garde son index d'origine → T3.
        assert_eq!(g.nodes[1].id, "T3");
    }

    #[test]
    fn parse_none_when_empty() {
        assert!(TaskGraph::parse(&json!({})).is_none());
        assert!(TaskGraph::parse(&json!({"todos": []})).is_none());
        assert!(TaskGraph::parse(&json!({"todos": [{"text": "", "status": "pending"}]})).is_none());
    }

    #[test]
    fn next_actionable_respects_deps() {
        let blocked = graph(json!({"todos": [
            {"id": "T1", "text": "setup", "status": "pending"},
            {"id": "T2", "text": "build", "status": "pending", "depends_on": ["T1"]}
        ]}));
        assert_eq!(blocked.next_actionable().unwrap().id, "T1");

        let unblocked = graph(json!({"todos": [
            {"id": "T1", "text": "setup", "status": "completed"},
            {"id": "T2", "text": "build", "status": "pending", "depends_on": ["T1"]}
        ]}));
        assert_eq!(unblocked.next_actionable().unwrap().id, "T2");
    }

    #[test]
    fn prioritises_in_progress() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "a", "status": "pending"},
            {"id": "T2", "text": "b", "status": "in_progress"}
        ]}));
        assert_eq!(g.next_actionable().unwrap().id, "T2");
    }

    #[test]
    fn detects_cycle_and_blocks_everything() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "a", "status": "pending", "depends_on": ["T2"]},
            {"id": "T2", "text": "b", "status": "pending", "depends_on": ["T1"]}
        ]}));
        assert!(
            g.warnings().iter().any(|m| m.contains("cycle")),
            "attendu un avertissement de cycle, got {:?}",
            g.warnings()
        );
        assert!(g.next_actionable().is_none());
    }

    #[test]
    fn flags_unknown_dep() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "a", "status": "pending", "depends_on": ["T9"]}
        ]}));
        assert!(g.warnings().iter().any(|m| m.contains("inconnu")));
    }

    #[test]
    fn flags_duplicate_id() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "a", "status": "pending"},
            {"id": "T1", "text": "b", "status": "pending"}
        ]}));
        assert!(g.warnings().iter().any(|m| m.contains("dupliqué")));
    }

    #[test]
    fn ack_mentions_progress_and_next() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "setup", "status": "completed"},
            {"id": "T2", "text": "build", "status": "pending", "depends_on": ["T1"]}
        ]}));
        let a = g.ack();
        assert!(a.contains("1/2"), "ack = {a}");
        assert!(a.contains("T2"), "ack = {a}");
    }

    #[test]
    fn reminder_marks_blocked_and_next() {
        let g = graph(json!({"todos": [
            {"id": "T1", "text": "setup", "status": "in_progress", "done_when": "build passe"},
            {"id": "T2", "text": "build", "status": "pending", "depends_on": ["T1"]}
        ]}));
        let r = g.reminder_block();
        assert!(r.contains("[bloqué]"), "reminder = {r}");
        assert!(r.contains("prochaine action : T1"), "reminder = {r}");
        assert!(r.contains("fini quand : build passe"), "reminder = {r}");
    }
}
