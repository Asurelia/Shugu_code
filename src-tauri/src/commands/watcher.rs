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
//!    event callback.  It collects events in a 200 ms burst window and, once
//!    quiet, emits a single `fs://changed` Tauri event.  The frontend re-fetches
//!    the tree on that event rather than trying to process individual diffs.
//!
//! ## Ignore filter
//!
//! Events whose paths fall entirely under ignored directory names (`.git`,
//! `node_modules`, `target`, etc.) are dropped before hitting the debouncer.
//! Reuses `super::fs::is_ignored` so the filter is identical to `fs_read_dir`.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Result as NotifyResult, Watcher};
use tauri::Emitter;

use super::fs::is_ignored;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Newtype wrapper for the root-change channel sender.
/// Stored in Tauri managed state so `fs_open_folder` can send the new root.
pub struct WatcherCtl(pub Sender<PathBuf>);

/// Spawn the manager + debouncer threads and return the root-change sender.
///
/// Call once during `setup()`.  The returned `Sender` is also wrapped in
/// `WatcherCtl` and stored via `.manage()` for use by `fs_open_folder`.
pub fn spawn_watcher(app: tauri::AppHandle) -> Sender<PathBuf> {
    let (tx_root, rx_root) = mpsc::channel::<PathBuf>();
    let (tx_evt, rx_evt) = mpsc::channel::<()>();

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
fn manager_loop(rx_root: Receiver<PathBuf>, tx_evt: Sender<()>) {
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
        // forwards relevant events to the debouncer.
        let mut watcher = match notify::recommended_watcher(
            move |res: NotifyResult<Event>| {
                if let Ok(event) = res {
                    if should_forward(&event) {
                        // Best-effort send; if the debouncer thread died, we
                        // just stop forwarding — don't panic the watcher.
                        let _ = tx_evt_clone.send(());
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

const DEBOUNCE_MS: u64 = 200;

/// Aggregates events in a 200 ms burst window and emits `fs://changed` once.
fn debouncer_loop(rx_evt: Receiver<()>, app: tauri::AppHandle) {
    loop {
        // Block until the first event arrives.
        if rx_evt.recv().is_err() {
            break; // sender (manager) dropped → shutdown
        }

        // Drain any additional events that arrive within the debounce window.
        let deadline = std::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx_evt.recv_timeout(remaining) {
                Ok(()) => {} // more events — keep draining
                Err(_) => break, // timeout or sender gone
            }
        }

        // Also drain any events that sneaked in exactly at the deadline.
        loop {
            match rx_evt.try_recv() {
                Ok(()) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        // Emit one consolidated event.
        if let Err(e) = app.emit("fs://changed", ()) {
            eprintln!("[watcher] emit fs://changed failed: {e}");
        }
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
}
