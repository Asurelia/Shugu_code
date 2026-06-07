//! S3 — Closed-loop lesson injection (Continual Harness).
//!
//! At the start of every agent run, we retrieve the most relevant VALIDATED
//! past reviews (via semantic search in `vec_patterns`) and inject them into
//! the agent's context so it avoids past mistakes and reuses what worked.
//!
//! ## Contract
//! - NEVER blocks or panics — every error path returns `(String::new(), 0)`.
//! - At most 3 lessons injected per run (enough signal, bounded noise).
//! - Only reviews with `validated = 1` (i.e. the reviewed run subsequently
//!   succeeded) qualify — unvalidated reviews may still be wrong.
//! - Body truncated at 600 Unicode scalar values (not bytes) to avoid UTF-8
//!   splits on French text.

/// Build the lessons prompt block for injection into the agent's system context.
///
/// Returns `(block, count)` where `block` is the formatted string to insert and
/// `count` is the number of lessons included. Returns `(String::new(), 0)` on
/// any error or when there are no validated lessons — callers MUST treat both
/// as "nothing to inject" without blocking the run.
pub(super) fn lessons_prompt_block(
    app: &tauri::AppHandle,
    _role: &str,
    task: &str,
) -> (String, usize) {
    if task.trim().is_empty() {
        return (String::new(), 0);
    }

    // Semantic search — k=8 gives enough candidates to find 3 validated ones
    // even when some hits have no matching review row.
    let hits = match crate::commands::vector::vec_search_internal(app, "patterns", task, 8) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[lessons] vec_search_internal failed, skipping lesson injection: {e}");
            return (String::new(), 0);
        }
    };

    // For each hit, look up the corresponding review row (reviewer_id = hit.id).
    // Only keep validated deliverable reviews.
    let conn_mutex = match super::get_conn(app) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[lessons] get_conn failed: {e}");
            return (String::new(), 0);
        }
    };
    let conn = match conn_mutex.lock() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[lessons] conn lock failed: {e}");
            return (String::new(), 0);
        }
    };

    // Collect ALL validated deliverable reviews among the hits (keeping their
    // semantic rank), then prioritise ACTIONABLE verdicts before taking the top
    // 3: a BLOQUÉ / À CORRIGER review teaches more than an APPROUVÉ one. Semantic
    // relevance (rank) breaks ties within a priority bucket.
    // reviewer_id is the bare UUID stored in vec_patterns; agent_reviews.reviewer_id
    // matches the vec id directly (PK is "rev_<uuid>", not used for the join).
    let mut candidates: Vec<(u8, usize, String, String)> = Vec::new(); // (prio, rank, verdict, body)
    for (rank, hit) in hits.iter().enumerate() {
        let result: rusqlite::Result<(String, String)> = conn.query_row(
            "SELECT body, verdict FROM agent_reviews \
              WHERE reviewer_id = ?1 AND kind = 'deliverable' AND validated = 1",
            rusqlite::params![hit.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        if let Ok((body, verdict)) = result {
            let prio = match verdict.as_str() {
                "BLOQUÉ" => 0u8,
                "À CORRIGER" => 1,
                "APPROUVÉ" => 2,
                _ => 3,
            };
            // Truncate at 600 Unicode scalar values, not bytes (French text has
            // multi-byte chars — byte-indexing would panic mid-character).
            let truncated: String = body.chars().take(600).collect();
            candidates.push((prio, rank, verdict, truncated));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let lessons: Vec<(String, String)> =
        candidates.into_iter().take(3).map(|(_, _, v, b)| (v, b)).collect();

    if lessons.is_empty() {
        return (String::new(), 0);
    }

    let count = lessons.len();
    let mut block = String::from(
        "[Leçons de runs passés similaires]\n\
         Des tâches proches ont déjà été reviewées et validées. \
         Tiens-en compte pour éviter les erreurs passées et réutiliser ce qui a marché.\n\n",
    );
    for (verdict, body) in &lessons {
        block.push_str(&format!("### Revue ({verdict})\n{body}\n\n"));
    }

    (block, count)
}
