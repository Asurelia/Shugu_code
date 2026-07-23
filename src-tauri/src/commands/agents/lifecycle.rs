//! Pure completion contract for the native agent loop.
//!
//! Prompts encourage a plan -> edit -> verify cycle, but prompts alone are not
//! a reliable control plane: a model can always stop emitting tool calls and
//! claim success.  This module turns the important parts of that cycle into
//! runtime evidence.  It intentionally has no Tauri/SQLite/network dependency
//! so the contract can be tested exhaustively.

use super::{ToolCall, ToolResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompletionBlockReason {
    MissingPlan,
    MissingExecution,
    MissingVerification,
}

impl CompletionBlockReason {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::MissingPlan => "missing_plan",
            Self::MissingExecution => "missing_execution",
            Self::MissingVerification => "missing_verification",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CompletionDecision {
    Complete,
    Continue {
        reason: CompletionBlockReason,
        nudge: String,
    },
}

/// Evidence accumulated across one `tool_use_loop` invocation.
///
/// A verification only covers mutations from strictly earlier rounds.  Tools
/// from one assistant turn may execute concurrently, so accepting a test that
/// appeared next to a write would create a race and a false proof.
#[derive(Debug, Default)]
pub(super) struct RunEvidence {
    round: u32,
    require_activity: bool,
    require_mutation: bool,
    successful_actions: u32,
    latest_plan_round: Option<u32>,
    successful_mutations: u32,
    last_mutation_round: Option<u32>,
    last_mutation_was_planned: bool,
    last_verification_round: Option<u32>,
    pending_plan_guarded_mutation: bool,
}

impl RunEvidence {
    pub(super) fn for_task(agent_mode: bool, task: &str) -> Self {
        Self {
            require_activity: agent_mode,
            require_mutation: agent_mode && task_requests_mutation(task),
            ..Self::default()
        }
    }

    pub(super) fn has_recorded_plan(&self) -> bool {
        self.latest_plan_round.is_some()
    }

    pub(super) fn needs_mutation_plan(&self) -> bool {
        self.require_mutation && self.latest_plan_round.is_none()
    }

    /// A compatibility recovery hint for providers that keep returning prose
    /// despite the controller nudge. The runner still filters this against the
    /// effective manifest before forcing it.
    pub(super) fn required_recovery_tool(&self) -> Option<&'static str> {
        if self.needs_mutation_plan() {
            return Some("todo_write");
        }
        if self.last_mutation_was_planned
            && self.last_mutation_round.is_some()
            && self.last_verification_round.is_none()
        {
            return Some("run_command");
        }
        None
    }

    pub(super) fn observe_round(&mut self, calls: &[ToolCall], results: &[ToolResult]) {
        self.round += 1;

        let succeeded = |call: &ToolCall| {
            results
                .iter()
                .find(|result| result.id == call.id)
                .filter(|result| !result.is_error)
        };

        // Capture this BEFORE recording a plan from the current round. A tool
        // refused by the plan-first gate is repaired by a successful retry of a
        // guarded tool under a plan from a strictly earlier round. This matters
        // for read-only shell commands such as `cd`: they are conservatively
        // plan-guarded before dispatch, but correctly carry no mutation marker
        // after execution and must not leave an impossible "missing execution"
        // debt forever.
        let guarded_retry_succeeded = self.latest_plan_round.is_some()
            && calls
                .iter()
                .any(|call| is_plan_guarded_tool(&call.name) && succeeded(call).is_some());

        let plan_succeeded = calls
            .iter()
            .any(|call| call.name == "todo_write" && succeeded(call).is_some());
        self.successful_actions += calls
            .iter()
            .filter(|call| succeeded(call).is_some())
            .count() as u32;

        let mutation_count = calls
            .iter()
            .filter(|call| {
                succeeded(call)
                    .map(|result| result_has_mutation(call, result))
                    .unwrap_or(false)
            })
            .count() as u32;

        if calls.iter().any(|call| {
            results
                .iter()
                .find(|result| result.id == call.id)
                .map(|result| result.is_error && result.content.starts_with(PLAN_REQUIRED_MARKER))
                .unwrap_or(false)
        }) {
            // The controller refused a mutation before it touched disk. Keep a
            // completion debt until the model records a plan and retries the
            // requested operation successfully; otherwise a plain-text success
            // after the refusal would still become a false positive.
            self.pending_plan_guarded_mutation = true;
        }

        if mutation_count > 0 {
            self.successful_mutations += mutation_count;
            self.last_mutation_round = Some(self.round);
            // Only a plan from a STRICTLY EARLIER round can govern a mutation:
            // tools in one model turn may execute concurrently.
            self.last_mutation_was_planned = self.latest_plan_round.is_some();
            // A newer mutation invalidates every earlier green check.
            self.last_verification_round = None;
            if self.last_mutation_was_planned {
                self.pending_plan_guarded_mutation = false;
            }
        }
        if guarded_retry_succeeded {
            self.pending_plan_guarded_mutation = false;
        }

        // Record a plan only after classifying this round's mutations, so a
        // todo_write emitted beside an edit cannot retroactively authorize it.
        if plan_succeeded {
            self.latest_plan_round = Some(self.round);
        }

        let verification_succeeded = calls.iter().any(|call| {
            succeeded(call)
                .map(|result| is_successful_verification(call, result))
                .unwrap_or(false)
        });

        if verification_succeeded
            && self
                .last_mutation_round
                .map(|mutation_round| self.round > mutation_round)
                .unwrap_or(false)
        {
            self.last_verification_round = Some(self.round);
        }
    }

    pub(super) fn completion_decision(&self, read_only: bool) -> CompletionDecision {
        // Read-only turns never manufacture a mutation contract.
        if read_only {
            return CompletionDecision::Complete;
        }

        if self.pending_plan_guarded_mutation {
            if self.latest_plan_round.is_none() {
                return CompletionDecision::Continue {
                    reason: CompletionBlockReason::MissingPlan,
                    nudge: "[Shugu execution gate] Une mutation a été refusée avant toute écriture car aucun plan exécutable n'était enregistré. Appelle `todo_write` maintenant avec les étapes concrètes. Les écritures et commandes ne seront autorisées qu'à partir du tour suivant.".to_string(),
                };
            }
            return CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                nudge: "[Shugu execution gate] Le plan est maintenant enregistré, mais la mutation précédente a été refusée et n'a jamais été exécutée. Réessaie l'écriture ou la commande prévue, puis vérifie réellement le résultat. Ne prétends pas que l'opération refusée a réussi.".to_string(),
            };
        }

        if self.require_mutation && self.successful_mutations == 0 {
            if self.latest_plan_round.is_none() {
                return CompletionDecision::Continue {
                    reason: CompletionBlockReason::MissingPlan,
                    nudge: "[Shugu task contract] Cette tâche en mode Agent demande une modification réelle, mais aucun plan ni changement vérifié n'existe encore. Commence par `todo_write`; au tour suivant, exécute la modification demandée puis vérifie-la.".to_string(),
                };
            }
            return CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                nudge: "[Shugu task contract] Le plan existe, mais la modification explicitement demandée n'a toujours pas été exécutée avec succès. Utilise maintenant l'outil d'écriture adapté, puis lance une vérification verte. Une description en prose ne satisfait pas la tâche.".to_string(),
            };
        }

        if self.require_activity && self.successful_actions == 0 {
            return CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                nudge: "[Shugu task contract] Ce run est en mode Agent, mais aucune action réelle n'a réussi. Utilise au moins un outil pertinent pour examiner ou exécuter la tâche avant de répondre. Pour une conversation sans action, le mode Chat doit être utilisé.".to_string(),
            };
        }

        // Informational turns and conversations that never attempted or
        // performed a mutation may legitimately finish without a plan/test.
        if self.successful_mutations == 0 {
            return CompletionDecision::Complete;
        }

        if !self.last_mutation_was_planned {
            return CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                nudge: "[Shugu completion gate] Une mutation non planifiée a déjà eu lieu. Enregistre immédiatement les étapes réelles via `todo_write`, puis effectue au moins une mutation corrective sous ce plan et une vérification verte postérieure. Un plan écrit après coup ne valide jamais rétroactivement l'écriture initiale.".to_string(),
            };
        }

        if self.last_verification_round.is_none() {
            return CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                nudge: "[Shugu completion gate] Tu as modifié le projet sans preuve verte postérieure à la dernière modification. Lance maintenant un vrai contrôle adapté au projet avec `run_command` (typecheck, tests, build, cargo check…) ou `browser_test` pour une interaction UI. Lis tout échec, corrige-le et relance. Ne déclare pas la tâche terminée avant un contrôle réussi.".to_string(),
            };
        }

        CompletionDecision::Complete
    }
}

const PLAN_REQUIRED_MARKER: &str = "[SHUGU_PLAN_REQUIRED]";

fn task_requests_mutation(task: &str) -> bool {
    // Durable Goal resumes append prior errors and outputs after an explicit
    // OBJECTIF block. Those diagnostics may mention words such as "modifier"
    // or "delete" while describing something that must NOT be repeated. The
    // user's objective remains the sole authority for mutation intent.
    let intent_scope = ["OBJECTIF :", "OBJECTIVE:"]
        .iter()
        .find_map(|marker| task.split_once(marker).map(|(_, tail)| tail))
        .and_then(|tail| tail.split("\n\n").next())
        .unwrap_or(task);
    let normalized: String = intent_scope
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            _ => c,
        })
        .collect();
    let words: Vec<&str> = normalized
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .collect();

    words.iter().enumerate().any(|(index, word)| {
        let is_mutation = matches!(
            *word,
            "add"
                | "ajoute"
                | "ajouter"
                | "change"
                | "changer"
                | "corrige"
                | "corriger"
                | "create"
                | "cree"
                | "creer"
                | "delete"
                | "deplace"
                | "deplacer"
                | "edit"
                | "ecris"
                | "ecrire"
                | "efface"
                | "effacer"
                | "fix"
                | "implement"
                | "implemente"
                | "implementer"
                | "modifie"
                | "modifier"
                | "move"
                | "refactor"
                | "refactorise"
                | "refactoriser"
                | "remove"
                | "rename"
                | "renomme"
                | "renommer"
                | "repare"
                | "reparer"
                | "replace"
                | "remplace"
                | "remplacer"
                | "supprime"
                | "supprimer"
                | "update"
                | "write"
        );
        if !is_mutation {
            return false;
        }

        // Intent is not a bag of keywords: "sans modifier", "ne modifie
        // pas", and "do not edit" explicitly forbid the very mutation verb
        // they contain. A short local window also carries "without" across
        // coordinators ("without editing or writing"), while contrast/sequence
        // words reset the scope so "ne modifie pas X, mais crée Y" stays
        // positive for the second instruction.
        let window = &words[index.saturating_sub(4)..index];
        let scoped_window = window
            .iter()
            .rposition(|token| ["mais", "but", "puis", "then"].contains(token))
            .map(|reset| &window[reset + 1..])
            .unwrap_or(window);
        let negated = scoped_window.iter().any(|token| {
            matches!(
                *token,
                "aucun"
                    | "aucune"
                    | "avoid"
                    | "don"
                    | "doesn"
                    | "interdit"
                    | "jamais"
                    | "ne"
                    | "never"
                    | "no"
                    | "not"
                    | "pas"
                    | "sans"
                    | "without"
            )
        });
        !negated
    })
}

pub(super) fn is_plan_guarded_tool(name: &str) -> bool {
    matches!(
        name,
        "fs_write_file" | "fs_edit" | "fs_delete" | "fs_move" | "run_command" | "delegate"
    )
}

pub(super) fn reject_unplanned_tool(call: &ToolCall, enforce: bool) -> Option<ToolResult> {
    if !enforce || !is_plan_guarded_tool(&call.name) {
        return None;
    }
    Some(ToolResult {
        id: call.id.clone(),
        name: call.name.clone(),
        is_error: true,
        content: format!(
            "{PLAN_REQUIRED_MARKER} outil `{}` non exécuté : appelle d'abord `todo_write` dans un tour séparé, puis réessaie cette opération. Aucun fichier ni processus n'a été modifié.",
            call.name
        ),
    })
}

fn result_has_mutation(call: &ToolCall, result: &ToolResult) -> bool {
    matches!(
        call.name.as_str(),
        "fs_write_file" | "fs_edit" | "fs_delete" | "fs_move" | "delegate"
    ) || (call.name == "run_command" && result.content.contains("[SHUGU_EFFECT: mutation]"))
}

fn is_successful_verification(call: &ToolCall, result: &ToolResult) -> bool {
    match call.name.as_str() {
        // `run_command` deliberately returns a normal ToolResult for non-zero
        // exits, because stderr is useful feedback for the next repair turn.
        // Therefore `is_error == false` alone is not proof of a green command.
        "run_command" => command_exit_code(&result.content) == Some(0),
        "browser_test" => result.content.contains("[SHUGU_VERIFY: passed]"),
        _ => false,
    }
}

fn command_exit_code(content: &str) -> Option<i32> {
    content.lines().find_map(|line| {
        line.trim()
            .strip_prefix("[exit ")?
            .strip_suffix(']')?
            .parse()
            .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: "{}".into(),
        }
    }

    fn result(id: &str, name: &str, is_error: bool, content: &str) -> ToolResult {
        ToolResult {
            id: id.into(),
            name: name.into(),
            is_error,
            content: content.into(),
        }
    }

    fn observe(evidence: &mut RunEvidence, id: &str, name: &str, content: &str) {
        evidence.observe_round(&[call(id, name)], &[result(id, name, false, content)]);
    }

    #[test]
    fn informational_turn_can_finish_without_plan_or_test() {
        assert_eq!(
            RunEvidence::default().completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn agent_mode_cannot_return_a_raw_prompt_response_without_action() {
        let evidence =
            RunEvidence::for_task(true, "Inspecte le projet et explique son architecture");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                ..
            }
        ));
    }

    #[test]
    fn explicit_french_mutation_task_requires_plan_then_real_change() {
        let mut evidence =
            RunEvidence::for_task(true, "Crée puis vérifie le fichier agent-proof.txt");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                ..
            }
        ));

        observe(&mut evidence, "p1", "todo_write", "plan saved");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                ..
            }
        ));

        observe(&mut evidence, "w1", "fs_write_file", "written");
        observe(&mut evidence, "t1", "run_command", "[exit 0]");
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn mutation_intent_classifier_handles_english_and_accents() {
        assert!(task_requests_mutation("Please fix the parser"));
        assert!(task_requests_mutation("Écris puis modifie ce fichier"));
        assert!(task_requests_mutation("Renomme la commande"));
        assert!(!task_requests_mutation("Explique pourquoi le test échoue"));
        assert!(!task_requests_mutation("Run the existing tests and report"));
    }

    #[test]
    fn mutation_intent_classifier_respects_explicit_negation() {
        assert!(!task_requests_mutation(
            "Inspecte ce workspace sans modifier de fichier"
        ));
        assert!(!task_requests_mutation(
            "Ne modifie pas les fichiers et ne crée rien"
        ));
        assert!(!task_requests_mutation(
            "Inspect the repository without editing or writing files"
        ));
        assert!(!task_requests_mutation(
            "Do not delete anything; only report what you find"
        ));
        assert!(task_requests_mutation(
            "Ne modifie pas README.md, mais crée report.md"
        ));
        assert!(!task_requests_mutation(
            "Reprends ce Goal.\n\nOBJECTIF : Inspecte sans modifier de fichier.\n\n\
             INTERRUPTION PRÉCÉDENTE : la modification demandée n'a pas été exécutée"
        ));
    }

    #[test]
    fn read_only_turn_is_never_forced_to_mutate() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "w1", "fs_write_file", "written");
        assert_eq!(
            evidence.completion_decision(true),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn mutation_requires_a_recorded_plan() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "w1", "fs_edit", "edited");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                ..
            }
        ));
    }

    #[test]
    fn controller_rejects_mutation_before_plan_without_touching_disk() {
        let mut evidence = RunEvidence::default();
        let write = call("w1", "fs_write_file");
        let blocked = reject_unplanned_tool(&write, !evidence.has_recorded_plan()).unwrap();
        assert!(blocked.is_error);
        assert!(blocked.content.starts_with(PLAN_REQUIRED_MARKER));

        evidence.observe_round(&[write], &[blocked]);
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                ..
            }
        ));
    }

    #[test]
    fn plan_in_same_round_does_not_execute_the_guarded_mutation() {
        let mut evidence = RunEvidence::default();
        let plan = call("p1", "todo_write");
        let write = call("w1", "fs_write_file");
        let blocked = reject_unplanned_tool(&write, !evidence.has_recorded_plan()).unwrap();
        evidence.observe_round(
            &[plan, write],
            &[result("p1", "todo_write", false, "plan saved"), blocked],
        );

        assert!(evidence.has_recorded_plan());
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingExecution,
                ..
            }
        ));
    }

    #[test]
    fn planned_retry_then_green_verification_clears_guard_debt() {
        let mut evidence = RunEvidence::default();
        let write = call("w1", "fs_write_file");
        let blocked = reject_unplanned_tool(&write, true).unwrap();
        evidence.observe_round(&[write], &[blocked]);
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w2", "fs_write_file", "written after plan");
        observe(&mut evidence, "t1", "run_command", "[exit 0]");

        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn planned_read_only_command_retry_clears_guard_debt_without_fake_mutation() {
        let mut evidence =
            RunEvidence::for_task(true, "Inspecte le projet et vérifie le chemin courant");
        let command = call("c1", "run_command");
        let blocked = reject_unplanned_tool(&command, true).unwrap();
        evidence.observe_round(&[command], &[blocked]);
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(
            &mut evidence,
            "c2",
            "run_command",
            "[EXECUTION: fullAccessDirect]\n[exit 0]\nF:\\Dev\\Comfyui",
        );

        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn plan_and_mutation_in_same_round_do_not_count_as_planned() {
        let mut evidence = RunEvidence::default();
        evidence.observe_round(
            &[call("p1", "todo_write"), call("w1", "fs_write_file")],
            &[
                result("p1", "todo_write", false, "plan saved"),
                result("w1", "fs_write_file", false, "written"),
            ],
        );
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                ..
            }
        ));
    }

    #[test]
    fn verification_in_same_parallel_round_does_not_prove_the_write() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        evidence.observe_round(
            &[call("w1", "fs_edit"), call("t1", "run_command")],
            &[
                result("w1", "fs_edit", false, "edited"),
                result("t1", "run_command", false, "[exit 0]\n--- stdout ---\nok"),
            ],
        );
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                ..
            }
        ));
    }

    #[test]
    fn non_zero_command_is_feedback_not_verification() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(
            &mut evidence,
            "t1",
            "run_command",
            "[exit 1]\n--- stderr ---\nfailed",
        );
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                ..
            }
        ));
    }

    #[test]
    fn later_green_command_satisfies_contract() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(
            &mut evidence,
            "t1",
            "run_command",
            "[exit 0]\n--- stdout ---\npassed",
        );
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn recovery_tool_tracks_plan_then_post_mutation_verification() {
        let mut evidence = RunEvidence::for_task(true, "create proof.txt");
        assert_eq!(evidence.required_recovery_tool(), Some("todo_write"));

        observe(&mut evidence, "p1", "todo_write", "plan saved");
        assert_eq!(evidence.required_recovery_tool(), None);

        observe(&mut evidence, "w1", "fs_write_file", "written");
        assert_eq!(evidence.required_recovery_tool(), Some("run_command"));

        observe(
            &mut evidence,
            "t1",
            "run_command",
            "[exit 1]\n--- stderr ---\nnot yet",
        );
        assert_eq!(evidence.required_recovery_tool(), Some("run_command"));

        observe(
            &mut evidence,
            "t2",
            "run_command",
            "[exit 0]\n--- stdout ---\npassed",
        );
        assert_eq!(evidence.required_recovery_tool(), None);
    }

    #[test]
    fn risk_banner_before_exit_does_not_hide_a_green_command() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(
            &mut evidence,
            "t1",
            "run_command",
            "[RISK: outsideWorkspace] command flagged but executed\n[exit 0]\n--- stdout ---\npassed",
        );
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn a_new_mutation_invalidates_an_earlier_green_check() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(&mut evidence, "t1", "run_command", "[exit 0]");
        observe(&mut evidence, "w2", "fs_edit", "edited again");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                ..
            }
        ));
    }

    #[test]
    fn successful_browser_test_can_verify_a_later_ui_round() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_write_file", "written");
        observe(
            &mut evidence,
            "b1",
            "browser_test",
            "[SHUGU_VERIFY: passed]\nall assertions passed",
        );
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn failed_mutation_does_not_create_a_completion_debt() {
        let mut evidence = RunEvidence::default();
        evidence.observe_round(
            &[call("w1", "fs_edit")],
            &[result("w1", "fs_edit", true, "old_string not found")],
        );
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn plan_written_after_mutation_cannot_retroactively_authorize_it() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(&mut evidence, "p1", "todo_write", "plan saved too late");
        observe(&mut evidence, "t1", "run_command", "[exit 0]");
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingPlan,
                ..
            }
        ));

        // A subsequent planned mutation repairs the contract.
        observe(&mut evidence, "w2", "fs_edit", "edited under plan");
        observe(&mut evidence, "t2", "run_command", "[exit 0]");
        assert_eq!(
            evidence.completion_decision(false),
            CompletionDecision::Complete
        );
    }

    #[test]
    fn shell_workspace_mutation_is_not_treated_as_an_informational_command() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(
            &mut evidence,
            "c1",
            "run_command",
            "[SHUGU_EFFECT: mutation]\n[exit 0]",
        );
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                ..
            }
        ));
    }

    #[test]
    fn failed_browser_assertion_is_not_green_evidence() {
        let mut evidence = RunEvidence::default();
        observe(&mut evidence, "p1", "todo_write", "plan saved");
        observe(&mut evidence, "w1", "fs_edit", "edited");
        observe(
            &mut evidence,
            "b1",
            "browser_test",
            "[SHUGU_VERIFY: failed]\nbrowser_test: FAILED",
        );
        assert!(matches!(
            evidence.completion_decision(false),
            CompletionDecision::Continue {
                reason: CompletionBlockReason::MissingVerification,
                ..
            }
        ));
    }
}
