//! Filesystem watcher for the Shugu workspace.
//!
//! ## Architecture
//!
//! Two background threads collaborate:
//!
//! 1. **Manager thread** — owns the active `RecommendedWatcher`.  Blocks on
//!    `rx_root`, a channel that receives a new `PathBuf` whenever the workspace
//!    root changes (from `fs_open_folder` or on startup restore).  On each
//!    receive it drops the old watcher and creates a fresh one watching the new
//!    root.
//!
//! 2. **Debouncer thread** — blocks on `rx_evt`, a channel fed by notify's
//!    event callback.  It serves TWO independent consumers off the SAME event
//!    stream:
//!
//!    a. **Tree invalidation** (unchanged): collects events in a 200 ms burst
//!       window and, once quiet, emits a single `fs://changed` Tauri event. The
//!       frontend re-fetches the tree on that event rather than processing diffs.
//!       This emit is BYTE-IDENTICAL to before (`app.emit("fs://changed", ())`)
//!       — `useEvents.ts` and friends listen on it with a `()` payload.
//!
//!    b. **Incremental reindex** (Phase 5): a SEPARATE, longer-debounced stage
//!       that relativizes the changed paths to the workspace and feeds each into
//!       the vector index (`vector::index_file_internal` for Added/Modified,
//!       `vector::delete_file_index_internal` for Removed). Runs entirely on the
//!       debouncer (background) thread so embeddings never touch the renderer.
//!       A STORM GUARD short-circuits checkout/branch-switch bursts (> 50 unique
//!       files) into a single `vec://index-stale` event instead of per-file work.
//!
//! ## Ignore filter
//!
//! Events whose paths fall entirely under ignored directory names (`.git`,
//! `node_modules`, `target`, etc.) are dropped before hitting the debouncer.
//! Reuses `super::fs::is_ignored` so the filter is identical to `fs_read_dir`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Result as NotifyResult, Watcher};
use tauri::{Emitter, Manager};

use super::fs::is_ignored;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Newtype wrapper for the root-change channel sender.
/// Stored in Tauri managed state so `fs_open_folder` can send the new root.
pub struct WatcherCtl(pub Sender<PathBuf>);

/// Classification of a forwarded filesystem event, derived from notify's
/// `EventKind`. The reindex stage needs to know whether a path was removed
/// (delete its index) or added/modified (re-embed it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// A file was created or its content changed → (re)index it.
    AddedOrModified,
    /// A file was removed → purge its index entry.
    Removed,
}

/// Map a notify `EventKind` to our coarse `ChangeKind`.
///
/// notify models a rename as either a paired Remove(old)+Create(new) or a
/// `Modify(Name(..))` carrying both paths. We classify `Modify(Name(From))` as
/// `Removed` (the old path vanished) and everything else modify-ish as
/// `AddedOrModified`. `index_file_internal` no-ops on a path that no longer
/// exists, so a misclassified rename half is self-correcting (a stale entry is
/// at worst left until the next touch, never a crash).
fn classify(kind: &EventKind) -> ChangeKind {
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Remove(_) => ChangeKind::Removed,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => ChangeKind::Removed,
        _ => ChangeKind::AddedOrModified,
    }
}

/// Spawn the manager + debouncer threads and return the root-change sender.
///
/// Call once during `setup()`.  The returned `Sender` is also wrapped in
/// `WatcherCtl` and stored via `.manage()` for use by `fs_open_folder`.
pub fn spawn_watcher(app: tauri::AppHandle) -> Sender<PathBuf> {
    let (tx_root, rx_root) = mpsc::channel::<PathBuf>();
    let (tx_evt, rx_evt) = mpsc::channel::<(ChangeKind, Vec<PathBuf>)>();

    // --- Debouncer thread ---------------------------------------------------
    let app_clone = app.clone();
    thread::Builder::new()
        .name("watcher-debouncer".into())
        .spawn(move || debouncer_loop(rx_evt, app_clone))
        .expect("spawn watcher-debouncer thread");

    // --- Manager thread -----------------------------------------------------
    thread::Builder::new()
        .name("watcher-manager".into())
        .spawn(move || manager_loop(rx_root, tx_evt))
        .expect("spawn watcher-manager thread");

    tx_root
}

// ---------------------------------------------------------------------------
// Manager loop
// ---------------------------------------------------------------------------

/// Owns the `RecommendedWatcher`.  Replaces it whenever a new root arrives.
fn manager_loop(rx_root: Receiver<PathBuf>, tx_evt: Sender<(ChangeKind, Vec<PathBuf>)>) {
    let mut active_watcher: Option<RecommendedWatcher> = None;

    loop {
        // Block until the root changes.
        let new_root = match rx_root.recv() {
            Ok(p) => p,
            Err(_) => break, // sender dropped → app shutting down
        };

        // Drop the old watcher (stops OS-level watching).
        drop(active_watcher.take());

        let tx_evt_clone = tx_evt.clone();

        // Build a new watcher whose callback filters ignored paths and
        // forwards relevant events (with their kind + paths) to the debouncer.
        let mut watcher = match notify::recommended_watcher(
            move |res: NotifyResult<Event>| {
                if let Ok(event) = res {
                    if should_forward(&event) {
                        // Best-effort send; if the debouncer thread died, we
                        // just stop forwarding — don't panic the watcher. We
                        // forward the FULL path set (the debouncer relativizes +
                        // re-filters ignored ones per path); `should_forward`
                        // already guarantees at least one path is relevant.
                        let kind = classify(&event.kind);
                        let _ = tx_evt_clone.send((kind, event.paths.clone()));
                    }
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] failed to create watcher: {e}");
                continue;
            }
        };

        if let Err(e) = watcher.watch(&new_root, RecursiveMode::Recursive) {
            eprintln!("[watcher] failed to watch {:?}: {e}", new_root);
            continue;
        }

        active_watcher = Some(watcher);
        eprintln!("[watcher] now watching {:?}", new_root);
    }
}

// ---------------------------------------------------------------------------
// Debouncer loop
// ---------------------------------------------------------------------------

/// Burst window for the `fs://changed` tree-invalidation emit (unchanged).
const DEBOUNCE_MS: u64 = 200;

/// Longer debounce for the incremental reindex stage. Saves are bursty (an
/// editor write often fires several notify events); waiting 1.5 s of quiet
/// before embedding collapses a multi-event save into ONE reindex per file and
/// keeps embedding work off the critical path of the fast tree refresh.
const REINDEX_DEBOUNCE_MS: u64 = 1_500;

/// Storm guard: if a reindex window accumulates more than this many UNIQUE files
/// (a checkout, branch switch, or `npm install` touching thousands of files), we
/// SKIP all per-file embedding work and emit a single `vec://index-stale` event
/// — the UI can offer a full reindex rather than the watcher hammering the
/// embedding model file-by-file.
const REINDEX_MAX_FILES: usize = 50;

/// Aggregates events on the SAME stream for two consumers:
///   - emits `fs://changed` once per 200 ms quiet burst (tree invalidation),
///   - flushes an incremental reindex once the stream is quiet for 1.5 s.
fn debouncer_loop(rx_evt: Receiver<(ChangeKind, Vec<PathBuf>)>, app: tauri::AppHandle) {
    // Pending per-path change kind for the reindex stage. Last writer wins for a
    // given path within a window (e.g. Modify then Remove → Removed). Keyed by
    // the ABSOLUTE path from notify; relativization happens at flush time when we
    // can read the current workspace root.
    let mut pending: HashMap<PathBuf, ChangeKind> = HashMap::new();
    // When set, the reindex must flush once `Instant::now() >= reindex_deadline`.
    let mut reindex_deadline: Option<Instant> = None;
    // When set, the `fs://changed` emit must fire once we've been quiet 200 ms.
    let mut fs_changed_deadline: Option<Instant> = None;

    loop {
        // Compute how long to block: until the SOONER of the two pending
        // deadlines, or indefinitely if neither is armed.
        let now = Instant::now();
        let wait = match (fs_changed_deadline, reindex_deadline) {
            (None, None) => None, // nothing pending — block until next event
            (a, b) => {
                let next = [a, b]
                    .into_iter()
                    .flatten()
                    .min()
                    .unwrap_or(now);
                Some(next.saturating_duration_since(now))
            }
        };

        let received = match wait {
            None => match rx_evt.recv() {
                Ok(v) => Some(v),
                Err(_) => break, // sender (manager) dropped → shutdown
            },
            Some(d) => match rx_evt.recv_timeout(d) {
                Ok(v) => Some(v),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Manager gone: flush whatever is pending, then exit so a
                    // reindex queued just before shutdown still lands.
                    if reindex_deadline.is_some() {
                        flush_reindex(&app, &mut pending);
                    }
                    break;
                }
            },
        };

        if let Some((kind, paths)) = received {
            // An event arrived: arm/extend BOTH debounce windows and record the
            // per-path change kind for the reindex stage.
            let now = Instant::now();
            fs_changed_deadline = Some(now + Duration::from_millis(DEBOUNCE_MS));
            reindex_deadline = Some(now + Duration::from_millis(REINDEX_DEBOUNCE_MS));
            for p in paths {
                pending.insert(p, kind);
            }
            continue;
        }

        // A timeout fired: check which deadline(s) elapsed.
        let now = Instant::now();
        if let Some(dl) = fs_changed_deadline {
            if now >= dl {
                fs_changed_deadline = None;
                // BYTE-IDENTICAL to the pre-Phase-5 behaviour — must not break
                // `useEvents.ts` (listens for `fs://changed` with a `()` payload).
                if let Err(e) = app.emit("fs://changed", ()) {
                    eprintln!("[watcher] emit fs://changed failed: {e}");
                }
            }
        }
        if let Some(dl) = reindex_deadline {
            if now >= dl {
                reindex_deadline = None;
                flush_reindex(&app, &mut pending);
            }
        }
    }
}

/// Flush the accumulated reindex buffer: relativize each absolute path to the
/// workspace root, drop ignored / out-of-root / directory paths, and either
/// (storm) emit `vec://index-stale`, or feed each surviving file into the
/// vector index. Always clears `pending`. Never panics; per-file errors are
/// counted and logged ONCE per window.
fn flush_reindex(app: &tauri::AppHandle, pending: &mut HashMap<PathBuf, ChangeKind>) {
    if pending.is_empty() {
        return;
    }
    // Drain the buffer regardless of outcome so a transient error can't pin
    // stale entries into the next window.
    let drained: Vec<(PathBuf, ChangeKind)> = pending.drain().collect();

    // Resolve the workspace root from managed state. If none is open we can't
    // relativize — drop the batch (the next full index/reopen rebuilds it).
    let root = match app.state::<Mutex<Option<PathBuf>>>().lock() {
        Ok(g) => match g.clone() {
            Some(r) => r,
            None => return,
        },
        Err(_) => return,
    };

    // Relativize + filter to workspace-relative FILE paths. We dedupe by the
    // relative path (a rename can yield two abs paths mapping to the same rel).
    let mut rel_changes: HashMap<String, ChangeKind> = HashMap::new();
    for (abs, kind) in drained {
        if let Some(rel) = relativize(&root, &abs) {
            // Skip anything under an ignored directory (mirrors should_forward,
            // which only checks at the EVENT level — a mixed event can still
            // carry an ignored path).
            if rel
                .split('/')
                .any(|seg| !seg.is_empty() && is_ignored(seg))
            {
                continue;
            }
            // Drop obvious directory events: a Removed dir has no index entry,
            // and an Added/Modified dir isn't a file to embed. We can't stat a
            // removed path, so we rely on `index_file_internal` no-op'ing a
            // non-file on the AddedOrModified side; for Removed we just attempt a
            // delete (a no-op when nothing was indexed under that key).
            rel_changes.insert(rel, kind);
        }
    }

    if rel_changes.is_empty() {
        return;
    }

    // STORM GUARD — a checkout / branch switch / mass install touches far more
    // files than an interactive edit. Above the threshold, skip per-file work
    // and tell the UI the index is stale (offer a full reindex) instead of
    // hammering the embedding model thousands of times on the watcher thread.
    if rel_changes.len() > REINDEX_MAX_FILES {
        eprintln!(
            "[watcher] reindex storm: {} files changed (> {}), emitting vec://index-stale",
            rel_changes.len(),
            REINDEX_MAX_FILES
        );
        if let Err(e) = app.emit("vec://index-stale", ()) {
            eprintln!("[watcher] emit vec://index-stale failed: {e}");
        }
        return;
    }

    // Per-file reindex. Embeddings run HERE, on the debouncer thread — never on
    // the renderer. One error counter + a single eprintln per window keeps the
    // log readable when (e.g.) the embedding model isn't ready yet.
    let mut errors = 0usize;
    let mut first_err: Option<String> = None;
    for (rel, kind) in rel_changes {
        let result = match kind {
            ChangeKind::AddedOrModified => {
                crate::commands::vector::index_file_internal(app, &root, &rel).map(|_| ())
            }
            ChangeKind::Removed => {
                crate::commands::vector::delete_file_index_internal(app, &rel)
            }
        };
        if let Err(e) = result {
            errors += 1;
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
    }
    if errors > 0 {
        eprintln!(
            "[watcher] reindex: {errors} file(s) failed this window (first: {})",
            first_err.as_deref().unwrap_or("?")
        );
    }
}

/// Relativize an absolute notify path to a workspace-relative, forward-slash
/// path (the SAME space as chunk ids / `fs_read_file`). Returns `None` when the
/// path is outside the root. Reuses the exact strip-prefix + `\\`→`/` logic from
/// fs.rs; the `\\?\` verbatim prefix cancels out because `root` is canonicalized
/// the same way notify reports paths on Windows.
fn relativize(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None // the root itself
    } else {
        Some(s)
    }
}

// ---------------------------------------------------------------------------
// Ignore filter
// ---------------------------------------------------------------------------

/// Returns `true` if the event carries at least one path that is NOT inside an
/// ignored directory.  Events whose every path lives under an ignored directory
/// (`.git`, `node_modules`, `target`, …) are silently discarded.
fn should_forward(event: &Event) -> bool {
    // We only care about create/modify/remove events, not access or metadata.
    match &event.kind {
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
        _ => return false,
    }

    if event.paths.is_empty() {
        return false;
    }

    // At least one path must escape all ignored directories.
    event.paths.iter().any(|p| {
        p.components().all(|c| {
            if let std::path::Component::Normal(name) = c {
                !is_ignored(&name.to_string_lossy())
            } else {
                true // non-Normal components (root, prefix, `.`, `..`) pass through
            }
        })
    })
}

// ---------------------------------------------------------------------------
// Reindex window planning (storm guard + relativization) — pure + testable
// ---------------------------------------------------------------------------

/// Outcome of planning a reindex window: either a per-file action list, or a
/// storm signal (too many files → emit `vec://index-stale` instead).
#[derive(Debug, PartialEq, Eq)]
pub enum ReindexPlan {
    /// Per-file changes, deduped by workspace-relative path.
    Files(Vec<(String, ChangeKind)>),
    /// The window exceeded `REINDEX_MAX_FILES` unique files — reindex is stale.
    Storm { unique_files: usize },
}

/// Pure planner mirroring `flush_reindex`'s decision logic, factored out so it
/// can be unit-tested without an `AppHandle`/managed state: relativize each abs
/// path against `root`, drop ignored / out-of-root paths, dedupe by rel path,
/// and apply the storm guard. The returned `Files` vec is sorted for
/// deterministic assertions.
fn plan_reindex(root: &Path, events: &[(ChangeKind, PathBuf)]) -> ReindexPlan {
    let mut rel_changes: HashMap<String, ChangeKind> = HashMap::new();
    for (kind, abs) in events {
        if let Some(rel) = relativize(root, abs) {
            if rel
                .split('/')
                .any(|seg| !seg.is_empty() && is_ignored(seg))
            {
                continue;
            }
            rel_changes.insert(rel, *kind);
        }
    }
    if rel_changes.len() > REINDEX_MAX_FILES {
        return ReindexPlan::Storm {
            unique_files: rel_changes.len(),
        };
    }
    let mut files: Vec<(String, ChangeKind)> = rel_changes.into_iter().collect();
    // Sort by the workspace-relative path (the key) for deterministic ordering;
    // ChangeKind needs no total order of its own.
    files.sort_by(|a, b| a.0.cmp(&b.0));
    ReindexPlan::Files(files)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    fn make_event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event { kind, paths, attrs: Default::default() }
    }

    #[test]
    fn should_forward_regular_file_create() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/workspace/src/main.rs")],
        );
        assert!(should_forward(&evt));
    }

    #[test]
    fn should_forward_ignores_git_path() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![PathBuf::from("/workspace/.git/COMMIT_EDITMSG")],
        );
        assert!(!should_forward(&evt), ".git events should be filtered");
    }

    #[test]
    fn should_forward_ignores_node_modules() {
        let evt = make_event(
            EventKind::Remove(RemoveKind::File),
            vec![PathBuf::from("/workspace/node_modules/react/index.js")],
        );
        assert!(!should_forward(&evt));
    }

    #[test]
    fn should_forward_passes_on_non_data_events() {
        // Access events should NOT be forwarded.
        let evt = make_event(
            EventKind::Access(notify::event::AccessKind::Read),
            vec![PathBuf::from("/workspace/src/lib.rs")],
        );
        assert!(!should_forward(&evt));
    }

    #[test]
    fn should_forward_empty_paths_is_false() {
        let evt = make_event(EventKind::Create(CreateKind::File), vec![]);
        assert!(!should_forward(&evt));
    }

    #[test]
    fn should_forward_mixed_paths_passes_if_any_is_outside_ignored() {
        // One path in .git, one path in src/ — should forward because src/ is not ignored.
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![
                PathBuf::from("/workspace/.git/index"),
                PathBuf::from("/workspace/src/new_file.rs"),
            ],
        );
        assert!(should_forward(&evt), "mixed events should forward when any path is outside ignored");
    }

    #[test]
    fn should_forward_target_dir_ignored() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/workspace/target/debug/my_crate")],
        );
        assert!(!should_forward(&evt));
    }

    // -----------------------------------------------------------------------
    // Phase 5 — classify + relativize + plan_reindex (storm guard)
    // -----------------------------------------------------------------------

    #[test]
    fn classify_maps_event_kinds() {
        use notify::event::{ModifyKind, RenameMode};
        assert_eq!(
            classify(&EventKind::Create(CreateKind::File)),
            ChangeKind::AddedOrModified
        );
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content))),
            ChangeKind::AddedOrModified
        );
        assert_eq!(
            classify(&EventKind::Remove(RemoveKind::File)),
            ChangeKind::Removed
        );
        // A rename's "from" half vanishes → treated as a removal.
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Name(RenameMode::From))),
            ChangeKind::Removed
        );
        // A rename's "to" half is a new path → add/modify.
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Name(RenameMode::To))),
            ChangeKind::AddedOrModified
        );
    }

    #[test]
    fn relativize_strips_root_and_normalizes_separators() {
        let root = PathBuf::from("/workspace/proj");
        assert_eq!(
            relativize(&root, &PathBuf::from("/workspace/proj/src/main.rs")),
            Some("src/main.rs".to_string())
        );
        // Outside the root → None.
        assert_eq!(
            relativize(&root, &PathBuf::from("/elsewhere/x.rs")),
            None
        );
        // The root itself → None.
        assert_eq!(relativize(&root, &root), None);
    }

    #[test]
    fn plan_reindex_relativizes_and_drops_ignored_and_outside() {
        let root = PathBuf::from("/ws");
        let events = vec![
            (ChangeKind::AddedOrModified, PathBuf::from("/ws/src/a.ts")),
            (ChangeKind::Removed, PathBuf::from("/ws/src/b.ts")),
            // ignored dir → dropped
            (ChangeKind::AddedOrModified, PathBuf::from("/ws/node_modules/x/i.js")),
            // outside root → dropped
            (ChangeKind::AddedOrModified, PathBuf::from("/other/c.ts")),
        ];
        match plan_reindex(&root, &events) {
            ReindexPlan::Files(files) => {
                assert_eq!(
                    files,
                    vec![
                        ("src/a.ts".to_string(), ChangeKind::AddedOrModified),
                        ("src/b.ts".to_string(), ChangeKind::Removed),
                    ]
                );
            }
            ReindexPlan::Storm { .. } => panic!("small window must not be a storm"),
        }
    }

    #[test]
    fn plan_reindex_dedupes_last_writer_wins() {
        let root = PathBuf::from("/ws");
        // Same file modified then removed within the window → Removed wins
        // (HashMap insert order in plan: last event for the path is kept here we
        // pass them in order so Removed is inserted last).
        let events = vec![
            (ChangeKind::AddedOrModified, PathBuf::from("/ws/src/a.ts")),
            (ChangeKind::Removed, PathBuf::from("/ws/src/a.ts")),
        ];
        match plan_reindex(&root, &events) {
            ReindexPlan::Files(files) => {
                assert_eq!(files, vec![("src/a.ts".to_string(), ChangeKind::Removed)]);
            }
            ReindexPlan::Storm { .. } => panic!("one file is not a storm"),
        }
    }

    #[test]
    fn plan_reindex_storm_guard_flips_above_threshold() {
        let root = PathBuf::from("/ws");
        // REINDEX_MAX_FILES + 1 unique files → storm.
        let events: Vec<(ChangeKind, PathBuf)> = (0..=REINDEX_MAX_FILES)
            .map(|i| {
                (
                    ChangeKind::AddedOrModified,
                    PathBuf::from(format!("/ws/src/file_{i}.ts")),
                )
            })
            .collect();
        assert!(events.len() > REINDEX_MAX_FILES);
        match plan_reindex(&root, &events) {
            ReindexPlan::Storm { unique_files } => {
                assert_eq!(unique_files, REINDEX_MAX_FILES + 1);
            }
            ReindexPlan::Files(_) => panic!("a >50-file burst must flip to the stale path"),
        }
    }

    #[test]
    fn plan_reindex_exactly_at_threshold_is_not_storm() {
        let root = PathBuf::from("/ws");
        // EXACTLY REINDEX_MAX_FILES unique files → still per-file (guard is `>`).
        let events: Vec<(ChangeKind, PathBuf)> = (0..REINDEX_MAX_FILES)
            .map(|i| {
                (
                    ChangeKind::AddedOrModified,
                    PathBuf::from(format!("/ws/src/file_{i}.ts")),
                )
            })
            .collect();
        assert_eq!(events.len(), REINDEX_MAX_FILES);
        match plan_reindex(&root, &events) {
            ReindexPlan::Files(files) => assert_eq!(files.len(), REINDEX_MAX_FILES),
            ReindexPlan::Storm { .. } => panic!("exactly 50 files is at the boundary, not over"),
        }
    }
}
