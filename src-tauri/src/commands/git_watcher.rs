//! Dedicated watcher for the `.git/` directory.
//!
//! ## Architecture (mirrors `watcher.rs`)
//!
//! Two background threads:
//!
//! 1. **Manager thread** — owns the active `RecommendedWatcher`. Blocks on
//!    `rx_root` (workspace root changes from `fs_open_folder`). On each new
//!    root it drops the previous watcher and starts watching the new
//!    `.git/` directory recursively. If `.git/` does not exist (plain folder
//!    that isn't a repository), the watcher silently no-ops until the next
//!    root arrives.
//!
//! 2. **Debouncer thread** — blocks on `rx_evt` (paths fed by notify's
//!    callback). Collects events in a 300 ms burst window and emits one
//!    `git://changed` Tauri event (empty payload). The frontend re-fetches
//!    status / log / branches on that signal.
//!
//! ## Filtered paths
//!
//! Only the following targets propagate to the debouncer:
//!
//!   - `.git/HEAD`        — branch switches, detached-HEAD checkouts
//!   - `.git/index`       — staging / unstaging / commits
//!   - `.git/MERGE_HEAD`  — merge in progress
//!   - `.git/ORIG_HEAD`   — recent reset / merge / rebase
//!   - `.git/refs/heads/*`   — local branch tip updates
//!   - `.git/refs/remotes/*` — fetched remote tip updates
//!
//! Pack-files, hooks, COMMIT_EDITMSG, FETCH_HEAD churn are intentionally
//! filtered out — they generate noise without changing the UI's view of
//! the world. Lockfiles like `index.lock` are also dropped (we only react
//! to the final `index` rename).

use std::path::{Component, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Result as NotifyResult, Watcher};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub struct WatcherCtl(pub Sender<PathBuf>);

pub fn spawn_git_watcher(app: tauri::AppHandle) -> Sender<PathBuf> {
    let (tx_root, rx_root) = mpsc::channel::<PathBuf>();
    let (tx_evt, rx_evt) = mpsc::channel::<()>();

    let app_clone = app.clone();
    thread::Builder::new()
        .name("git-watcher-debouncer".into())
        .spawn(move || debouncer_loop(rx_evt, app_clone))
        .expect("spawn git-watcher-debouncer thread");

    thread::Builder::new()
        .name("git-watcher-manager".into())
        .spawn(move || manager_loop(rx_root, tx_evt))
        .expect("spawn git-watcher-manager thread");

    tx_root
}

// ---------------------------------------------------------------------------
// Manager loop
// ---------------------------------------------------------------------------

fn manager_loop(rx_root: Receiver<PathBuf>, tx_evt: Sender<()>) {
    let mut active_watcher: Option<RecommendedWatcher> = None;

    loop {
        let new_root = match rx_root.recv() {
            Ok(p) => p,
            Err(_) => break, // sender dropped — shutting down
        };

        drop(active_watcher.take());

        let git_dir = new_root.join(".git");
        if !git_dir.is_dir() {
            // Not a repo (or fresh folder) — leave watcher unset; we'll
            // wait for the next root change.
            eprintln!("[git-watcher] no .git/ in {:?}, idle", new_root);
            continue;
        }

        let tx_evt_clone = tx_evt.clone();
        let git_dir_for_filter = git_dir.clone();

        let mut watcher = match notify::recommended_watcher(
            move |res: NotifyResult<Event>| {
                if let Ok(event) = res {
                    if should_forward(&event, &git_dir_for_filter) {
                        let _ = tx_evt_clone.send(());
                    }
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[git-watcher] failed to create watcher: {e}");
                continue;
            }
        };

        if let Err(e) = watcher.watch(&git_dir, RecursiveMode::Recursive) {
            eprintln!("[git-watcher] failed to watch {:?}: {e}", git_dir);
            continue;
        }

        active_watcher = Some(watcher);
        eprintln!("[git-watcher] now watching {:?}", git_dir);
    }
}

// ---------------------------------------------------------------------------
// Debouncer loop
// ---------------------------------------------------------------------------

const DEBOUNCE_MS: u64 = 300;

fn debouncer_loop(rx_evt: Receiver<()>, app: tauri::AppHandle) {
    loop {
        if rx_evt.recv().is_err() {
            break;
        }

        let deadline = std::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx_evt.recv_timeout(remaining) {
                Ok(()) => {}
                Err(_) => break,
            }
        }

        loop {
            match rx_evt.try_recv() {
                Ok(()) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        if let Err(e) = app.emit("git://changed", ()) {
            eprintln!("[git-watcher] emit git://changed failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/// Returns true if the event touches one of the 6 targets we care about
/// (HEAD, index, MERGE_HEAD, ORIG_HEAD, refs/heads/*, refs/remotes/*).
///
/// `git_dir` is the absolute path to the `.git` directory.
fn should_forward(event: &Event, git_dir: &std::path::Path) -> bool {
    match &event.kind {
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
        _ => return false,
    }

    if event.paths.is_empty() {
        return false;
    }

    event.paths.iter().any(|p| is_target_path(p, git_dir))
}

fn is_target_path(p: &std::path::Path, git_dir: &std::path::Path) -> bool {
    let rel = match p.strip_prefix(git_dir) {
        Ok(r) => r,
        Err(_) => return false,
    };

    let components: Vec<&std::ffi::OsStr> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect();

    if components.is_empty() {
        return false;
    }

    // Skip lockfiles (index.lock, HEAD.lock, etc.) — we only react to the
    // final rename, not the staging .lock dance.
    let last = components[components.len() - 1].to_string_lossy();
    if last.ends_with(".lock") {
        return false;
    }

    match components[0].to_string_lossy().as_ref() {
        "HEAD" | "index" | "MERGE_HEAD" | "ORIG_HEAD" => components.len() == 1,
        "refs" => {
            if components.len() < 3 {
                return false;
            }
            let scope = components[1].to_string_lossy();
            matches!(scope.as_ref(), "heads" | "remotes")
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    fn make_event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event {
            kind,
            paths,
            attrs: Default::default(),
        }
    }

    fn git_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\workspace\.git")
        } else {
            PathBuf::from("/workspace/.git")
        }
    }

    fn join(parts: &[&str]) -> PathBuf {
        let mut p = git_dir();
        for part in parts {
            p.push(part);
        }
        p
    }

    #[test]
    fn forwards_head_update() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["HEAD"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn forwards_index_update() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["index"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn forwards_merge_head() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![join(&["MERGE_HEAD"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn forwards_orig_head() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![join(&["ORIG_HEAD"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn forwards_local_branch_ref() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["refs", "heads", "main"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn forwards_remote_branch_ref() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["refs", "remotes", "origin", "main"])],
        );
        assert!(should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_pack_files() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![join(&["objects", "pack", "pack-abc.pack"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_commit_editmsg() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["COMMIT_EDITMSG"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_fetch_head() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![join(&["FETCH_HEAD"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_lockfiles() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![join(&["index.lock"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_refs_tags() {
        let evt = make_event(
            EventKind::Create(CreateKind::File),
            vec![join(&["refs", "tags", "v1.0"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_paths_outside_git_dir() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![PathBuf::from(if cfg!(windows) {
                r"C:\workspace\src\lib.rs"
            } else {
                "/workspace/src/lib.rs"
            })],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn ignores_non_data_events() {
        let evt = make_event(
            EventKind::Access(notify::event::AccessKind::Read),
            vec![join(&["HEAD"])],
        );
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn empty_paths_is_false() {
        let evt = make_event(EventKind::Remove(RemoveKind::File), vec![]);
        assert!(!should_forward(&evt, &git_dir()));
    }

    #[test]
    fn mixed_events_forward_when_any_target() {
        let evt = make_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![
                join(&["objects", "pack", "abc.pack"]),
                join(&["HEAD"]),
            ],
        );
        assert!(should_forward(&evt, &git_dir()));
    }
}
