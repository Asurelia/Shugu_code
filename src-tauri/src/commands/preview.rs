//! `preview://` custom URI-scheme protocol — Design Studio live preview (Phase B).
//!
//! Serves the agent-generated project from `<workspace_root>/.shugu-forge/preview/`
//! so the Studio's iframe can render a REAL multi-file project: because every
//! file is served under the single `preview://` origin, relative imports
//! (`href="styles.css"`, `src="script.js"`) resolve naturally — no path
//! rewriting, no local HTTP server, no new dependency.
//!
//! URL shape: `preview://localhost/<path>` (Windows: `http://preview.localhost/<path>`).
//! `/` maps to `index.html`. Any path component that could escape the base dir
//! (`..`, absolute prefixes) is rejected with 404.
//!
//! The handler is registered in `lib.rs` via a closure that forwards
//! `ctx.app_handle()` + the request path to [`serve`], so we never have to name
//! `UriSchemeContext` here (its import path is version-sensitive).

use std::borrow::Cow;
use std::path::{Component, PathBuf};
use std::sync::Mutex;

use tauri::http::Response;
use tauri::{AppHandle, Manager};

/// Workspace-relative directory the Studio generation writes into and the
/// preview serves from. Kept in sync with `GENERATION_MODE_PROMPT`
/// (agents/runner.rs), which instructs the agent to write here.
const PREVIEW_SUBDIR: &str = ".shugu-forge/preview";

fn guess_mime(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn respond(status: u16, mime: &str, body: Cow<'static, [u8]>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        // The iframe host page is a different origin (tauri/localhost), so allow
        // it to read these responses. Content is our own generated project.
        .header("Access-Control-Allow-Origin", "*")
        // Always serve the freshest bytes — the agent rewrites files live.
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    respond(
        404,
        "text/html; charset=utf-8",
        Cow::Borrowed(
            b"<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;color:#a5a0bf;background:#0d0d18;display:grid;place-items:center;height:100vh;margin:0\">Aucun projet g\xc3\xa9n\xc3\xa9r\xc3\xa9 pour l'instant." as &[u8],
        ),
    )
}

/// A tiny controller injected into every served HTML page so the Studio can
/// drive element selection across the cross-origin iframe boundary. It is inert
/// until the parent app turns on select-mode via `postMessage`; on a click it
/// reports the chosen element's descriptor back to the parent. It never alters
/// the generated markup/styles — only a temporary outline while hovering in
/// select-mode.
///
/// Security note: the controller posts the selected element back to the parent
/// with `targetOrigin: "*"` because an injected script cannot know the host
/// app's origin. This is acceptable here — the payload is a non-sensitive
/// element descriptor from the user's own generated page — and the parent side
/// verifies `event.origin` before acting on it.
const CONTROLLER_SCRIPT: &str = r##"<script>
(function(){
  if(window.__shuguStudio)return;window.__shuguStudio=true;
  var sel=false,hov=null;
  function out(el,v){try{el.style.outline=v;}catch(e){}}
  function setHov(el){if(hov===el)return;if(hov)out(hov,hov.__o||"");hov=el;if(el&&el.style){el.__o=el.style.outline;out(el,"2px solid #e08efe");}}
  function desc(el){
    var tag=(el.tagName||"").toLowerCase();
    var id=el.id?("#"+el.id):"";
    var cls=(el.className&&typeof el.className==="string")?("."+el.className.trim().split(/\s+/).filter(Boolean).join(".")):"";
    var text=(el.textContent||"").trim().replace(/\s+/g," ").slice(0,80);
    var oh=el.outerHTML||"";var gt=oh.indexOf(">");var open=gt>=0?oh.slice(0,gt+1):oh.slice(0,120);
    return{tag:tag,selector:(tag+id+cls).slice(0,160),text:text,open:open.slice(0,200)};
  }
  window.addEventListener("message",function(e){
    var d=e.data||{};
    if(d.type==="shugu:setSelectMode"){sel=!!d.on;try{document.body.style.cursor=sel?"crosshair":"";}catch(e2){}if(!sel)setHov(null);}
  });
  document.addEventListener("mouseover",function(e){if(sel)setHov(e.target);},true);
  document.addEventListener("click",function(e){
    if(!sel)return;e.preventDefault();e.stopPropagation();
    var el=e.target;setHov(null);sel=false;try{document.body.style.cursor="";}catch(e3){}
    try{parent.postMessage({type:"shugu:selected",el:desc(el)},"*");}catch(err){}
  },true);
})();
</script>"##;

/// Insert the controller script just before `</body>` (or append if absent).
/// `to_ascii_lowercase` preserves byte positions, so the index is valid in `s`.
fn inject_controller(html: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(html);
    let lower = s.to_ascii_lowercase();
    if let Some(idx) = lower.rfind("</body>") {
        let mut out = String::with_capacity(s.len() + CONTROLLER_SCRIPT.len());
        out.push_str(&s[..idx]);
        out.push_str(CONTROLLER_SCRIPT);
        out.push_str(&s[idx..]);
        out.into_bytes()
    } else {
        let mut out = s.into_owned();
        out.push_str(CONTROLLER_SCRIPT);
        out.into_bytes()
    }
}

/// Resolve + read a file under `<workspace>/.shugu-forge/preview/`. Returns a
/// 404 response when there is no open workspace, the path escapes the base, or
/// the file is missing.
pub fn serve(app: &AppHandle, raw_path: &str) -> Response<Cow<'static, [u8]>> {
    // Live workspace root from managed state (seeded on startup from the
    // settings table, updated by fs_open_folder). On Windows this is the
    // canonical `\\?\`-prefixed path — std::fs::read handles it fine.
    let root: PathBuf = {
        let state = app.state::<Mutex<Option<PathBuf>>>();
        let guard = match state.lock() {
            Ok(g) => g,
            Err(_) => return not_found(),
        };
        match guard.clone() {
            Some(r) => r,
            None => return not_found(),
        }
    };

    let mut base = root;
    for part in PREVIEW_SUBDIR.split('/') {
        base.push(part);
    }

    // Decode %xx, drop the leading slash, default to index.html.
    let decoded = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy();
    let rel = decoded.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    // Build the target path component-by-component, rejecting anything that
    // could escape the base (`..`, absolute prefixes, root dir).
    let mut target = base.clone();
    for comp in std::path::Path::new(rel).components() {
        match comp {
            Component::Normal(c) => target.push(c),
            Component::CurDir => {}
            _ => return not_found(),
        }
    }

    match std::fs::read(&target) {
        Ok(bytes) => {
            let mime = guess_mime(&target);
            // Inject the Studio controller into HTML so element selection works
            // across the cross-origin iframe boundary (postMessage bridge).
            if mime.starts_with("text/html") {
                respond(200, mime, Cow::Owned(inject_controller(&bytes)))
            } else {
                respond(200, mime, Cow::Owned(bytes))
            }
        }
        Err(_) => not_found(),
    }
}
