//! Coalescing buffer for streaming `Delta` events.
//!
//! Token-level deltas used to be broadcast 1:1 on the Tauri event bus —
//! with 4 concurrent agents at 30+ tokens/s that's 120+ events/s delivered
//! to EVERY webview (main + mascot). Each event costs an IPC serialization,
//! a webview wake-up and a React cache write per window; the mascot window
//! froze under that load (observed 2026-06-13). Chunks are now accumulated
//! per `(agent_id, delta_kind)` and flushed as ONE merged Delta once the
//! buffer is older than [`FLUSH_INTERVAL`] — ~14 updates/s, visually
//! indistinguishable for streaming text, ~8-10× fewer events on the bus.
//!
//! Ordering contract: callers MUST [`drain`] an agent's buffers BEFORE
//! emitting any non-delta event for that agent (`persist_and_emit` does),
//! so the frontend always sees deltas → Message/ToolCall/Complete in order.
//! The flush of a stream's tail is structurally guaranteed: the runner
//! always emits a terminal Message/Complete/Error after the last chunk.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// A merged Delta is emitted at most once per interval per (agent, kind).
const FLUSH_INTERVAL: Duration = Duration::from_millis(70);

type Key = (String, String); // (agent_id, delta_kind)

struct Entry {
    acc: String,
    first_chunk: Instant,
}

static BUFFERS: OnceLock<Mutex<HashMap<Key, Entry>>> = OnceLock::new();

fn lock_buffers() -> MutexGuard<'static, HashMap<Key, Entry>> {
    BUFFERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        // A panic while holding this lock only leaves a half-merged chunk
        // behind — recover the map instead of poisoning every later stream.
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Append `chunk` to the (agent, kind) buffer. Returns the merged chunk to
/// emit when the buffer has been accumulating for at least [`FLUSH_INTERVAL`],
/// `None` while it is still coalescing.
pub(super) fn push(agent_id: &str, delta_kind: &str, chunk: &str) -> Option<String> {
    push_at(agent_id, delta_kind, chunk, Instant::now())
}

fn push_at(agent_id: &str, delta_kind: &str, chunk: &str, now: Instant) -> Option<String> {
    let mut map = lock_buffers();
    let key = (agent_id.to_string(), delta_kind.to_string());
    let entry = map.entry(key.clone()).or_insert_with(|| Entry {
        acc: String::new(),
        first_chunk: now,
    });
    entry.acc.push_str(chunk);
    if now.duration_since(entry.first_chunk) >= FLUSH_INTERVAL {
        map.remove(&key).map(|e| e.acc)
    } else {
        None
    }
}

/// Remove and return every pending buffer for `agent_id` as
/// `(delta_kind, merged_chunk)` pairs, reasoning before content (reasoning
/// precedes content within a model turn). Empty vec when nothing is pending.
pub(super) fn drain(agent_id: &str) -> Vec<(String, String)> {
    let mut map = lock_buffers();
    let keys: Vec<Key> = map
        .keys()
        .filter(|(aid, _)| aid == agent_id)
        .cloned()
        .collect();
    let mut out: Vec<(String, String)> = keys
        .into_iter()
        .filter_map(|key| {
            let entry = map.remove(&key)?;
            Some((key.1, entry.acc))
        })
        .collect();
    out.sort_by_key(|(kind, _)| if kind == "reasoning" { 0 } else { 1 });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE — BUFFERS is process-global and tests run in parallel: every test
    // uses its own agent_id so they never observe each other's entries.

    #[test]
    fn coalesces_chunks_then_flushes_after_interval() {
        let t0 = Instant::now();
        assert_eq!(push_at("t-agent-1", "content", "Hel", t0), None);
        assert_eq!(
            push_at("t-agent-1", "content", "lo", t0 + Duration::from_millis(20)),
            None
        );
        // Third chunk arrives past the interval → whole accumulation emitted.
        assert_eq!(
            push_at(
                "t-agent-1",
                "content",
                " world",
                t0 + Duration::from_millis(80)
            ),
            Some("Hello world".to_string())
        );
        // Buffer was consumed — nothing left to drain.
        assert!(drain("t-agent-1").is_empty());
    }

    #[test]
    fn kinds_accumulate_independently() {
        let t0 = Instant::now();
        assert_eq!(push_at("t-agent-2", "reasoning", "think", t0), None);
        assert_eq!(push_at("t-agent-2", "content", "say", t0), None);
        let drained = drain("t-agent-2");
        assert_eq!(
            drained,
            vec![
                ("reasoning".to_string(), "think".to_string()),
                ("content".to_string(), "say".to_string()),
            ]
        );
    }

    #[test]
    fn drain_before_non_delta_preserves_pending_tail() {
        // Simulates the persist_and_emit contract: a sub-interval tail chunk
        // must come out via drain() before the terminal event is emitted.
        let t0 = Instant::now();
        assert_eq!(push_at("t-agent-3", "content", "tail", t0), None);
        let drained = drain("t-agent-3");
        assert_eq!(drained, vec![("content".to_string(), "tail".to_string())]);
    }

    #[test]
    fn drain_only_touches_the_requested_agent() {
        let t0 = Instant::now();
        assert_eq!(push_at("t-agent-4a", "content", "mine", t0), None);
        assert_eq!(push_at("t-agent-4b", "content", "theirs", t0), None);
        assert_eq!(
            drain("t-agent-4a"),
            vec![("content".to_string(), "mine".to_string())]
        );
        // The other agent's buffer is untouched.
        assert_eq!(
            drain("t-agent-4b"),
            vec![("content".to_string(), "theirs".to_string())]
        );
    }
}
