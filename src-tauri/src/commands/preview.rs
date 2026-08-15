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

/// An absent Studio entry point is a normal first-run state, not a failed
/// network resource. Return a successful placeholder so WebView2 does not emit
/// a console 404 while the user has not generated a project yet. Missing assets
/// and rejected paths continue to use [`not_found`].
fn empty_preview() -> Response<Cow<'static, [u8]>> {
    respond(
        200,
        "text/html; charset=utf-8",
        Cow::Borrowed(
            b"<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;color:#a5a0bf;background:#0d0d18;display:grid;place-items:center;height:100vh;margin:0\">Aucun projet g\xc3\xa9n\xc3\xa9r\xc3\xa9 pour l'instant.</body>" as &[u8],
        ),
    )
}

/// A tiny controller injected into every served HTML page so the Studio can
/// reach into the cross-origin iframe. Inert until the parent asks via
/// `postMessage`. Capabilities:
///   1. Element selection — on `shugu:setSelectMode`, a click reports the
///      chosen element's descriptor back; only a temporary hover outline is
///      drawn, never a markup/style change. The picked element is remembered
///      for the style probe below.
///   2. Live Tweaks — on `shugu:getTokens` it reports the `:root` custom
///      properties (`--*`) it discovers; on `shugu:setToken` it applies one via
///      `style.setProperty` on the root for instant preview.
///   3. Direct text edit (Lot A) — on `shugu:setEditMode`, a double-click on an
///      element with its own text turns it `contentEditable`; commit
///      (blur / Enter) posts `shugu:textEdited` with old/new text, Escape
///      reverts. The parent then patches the source file.
///   4. Element styles (Lot A) — `shugu:probeStyles` reports a fixed list of
///      computed styles of the picked element; `shugu:setElStyle` applies one
///      inline at runtime (runtime-only until baked).
///   5. Pins (Lot B) — on `shugu:setPinMode`, clicks post `shugu:pinPlaced`
///      with the element descriptor + click position relative to the viewport.
///   6. DOM layers (Lot E) — `shugu:getDomTree` posts a flat capped walk of
///      the document; `shugu:highlight` / `shugu:unhighlight` outline an item,
///      `shugu:pickIndex` selects it.
///
/// Security note: the controller posts back to the parent with
/// `targetOrigin: "*"` because an injected script cannot know the host app's
/// origin. This is acceptable here — payloads are non-sensitive (element
/// descriptors, `--*` design tokens, computed styles — all from the user's own
/// generated page) and the parent verifies `event.origin` before acting.
/// Inbound writes only touch `--*` custom properties on `:root`, inline styles
/// of the picked element, or its own text — none can escalate beyond restyling
/// or rewording the preview.
const CONTROLLER_SCRIPT: &str = r##"<script>
(function(){
  if(window.__shuguStudio)return;window.__shuguStudio=true;
  var sel=false,hov=null,picked=null,editOn=false,pinOn=false,editing=null,oldText="",domCache=[];
  var PROBED=["color","background-color","font-size","font-weight","line-height","letter-spacing","padding","margin","border-radius","gap"];
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
  function tok(){
    var names={};
    for(var i=0;i<document.styleSheets.length;i++){
      var sheet=document.styleSheets[i],rules;
      try{rules=sheet.cssRules||sheet.rules;}catch(e){continue;}
      if(!rules)continue;
      for(var j=0;j<rules.length;j++){
        var r=rules[j];if(!r||!r.style||!r.selectorText)continue;
        var st=(r.selectorText||"").toLowerCase();
        if(st.indexOf(":root")<0&&st.indexOf("html")<0)continue;
        for(var k=0;k<r.style.length;k++){var p=r.style[k];if(p&&p.indexOf("--")===0)names[p]=true;}
      }
    }
    var cs=getComputedStyle(document.documentElement),out=[];
    for(var name in names){if(!names.hasOwnProperty(name))continue;out.push({name:name,value:(cs.getPropertyValue(name)||"").trim()});}
    out.sort(function(a,b){return a.name<b.name?-1:(a.name>b.name?1:0);});
    return out;
  }
  function ownText(el){
    for(var i=0;i<el.childNodes.length;i++){var n=el.childNodes[i];if(n.nodeType===3&&(n.textContent||"").trim())return true;}
    return false;
  }
  function commitEdit(cancel){
    if(!editing)return;var el=editing;editing=null;
    try{el.removeAttribute("contenteditable");}catch(e){}
    var nt=(el.textContent||"").trim().replace(/\s+/g," ");
    if(!cancel&&nt&&nt!==oldText){
      try{parent.postMessage({type:"shugu:textEdited",el:desc(el),oldText:oldText,newText:nt},"*");}catch(e2){}
    }else if(cancel){try{el.textContent=oldText;}catch(e3){}}
  }
  function probe(){
    if(!picked)return;
    var cs=getComputedStyle(picked),arr=[];
    for(var i=0;i<PROBED.length;i++){arr.push({prop:PROBED[i],value:(cs.getPropertyValue(PROBED[i])||"").trim()});}
    try{parent.postMessage({type:"shugu:elStyles",styles:arr},"*");}catch(e){}
  }
  function domTree(){
    domCache=[];var list=[];var MAX=250;
    function walk(el,depth){
      if(domCache.length>=MAX||depth>6)return;
      var tag=(el.tagName||"").toLowerCase();
      if(tag==="script"||tag==="style"||tag==="noscript"||tag==="link"||tag==="meta")return;
      var id=el.id?("#"+el.id):"";
      var cls=(el.className&&typeof el.className==="string")?("."+el.className.trim().split(/\s+/).filter(Boolean).slice(0,3).join(".")):"";
      var t="";
      for(var i=0;i<el.childNodes.length;i++){var n=el.childNodes[i];if(n.nodeType===3){t=(n.textContent||"").trim().replace(/\s+/g," ");if(t)break;}}
      domCache.push(el);
      list.push({i:domCache.length-1,depth:depth,tag:tag,suffix:(id+cls).slice(0,80),text:t.slice(0,40)});
      var kids=el.children;
      for(var k=0;k<kids.length;k++)walk(kids[k],depth+1);
    }
    try{if(document.body)walk(document.body,0);}catch(e){}
    try{parent.postMessage({type:"shugu:domTree",nodes:list},"*");}catch(e2){}
  }
  window.addEventListener("message",function(e){
    var d=e.data||{};
    if(d.type==="shugu:setSelectMode"){sel=!!d.on;try{document.body.style.cursor=sel?"crosshair":"";}catch(e2){}if(!sel)setHov(null);}
    else if(d.type==="shugu:setEditMode"){editOn=!!d.on;if(!editOn)commitEdit(true);}
    else if(d.type==="shugu:setPinMode"){pinOn=!!d.on;try{document.body.style.cursor=pinOn?"copy":(sel?"crosshair":"");}catch(e6){}}
    else if(d.type==="shugu:getTokens"){try{parent.postMessage({type:"shugu:tokens",tokens:tok()},"*");}catch(e4){}}
    else if(d.type==="shugu:setToken"&&d.name&&d.name.indexOf("--")===0){try{document.documentElement.style.setProperty(d.name,d.value);}catch(e5){}}
    else if(d.type==="shugu:probeStyles"){probe();}
    else if(d.type==="shugu:setElStyle"&&d.prop){try{if(picked)picked.style.setProperty(d.prop,d.value);}catch(e7){}}
    else if(d.type==="shugu:getDomTree"){domTree();}
    else if(d.type==="shugu:highlight"){var el=domCache[d.i];if(el)setHov(el);}
    else if(d.type==="shugu:unhighlight"){setHov(null);}
    else if(d.type==="shugu:pickIndex"){var el2=domCache[d.i];if(el2){picked=el2;try{parent.postMessage({type:"shugu:selected",el:desc(el2)},"*");}catch(e8){}}}
  });
  document.addEventListener("mouseover",function(e){if(sel)setHov(e.target);},true);
  document.addEventListener("click",function(e){
    if(pinOn){
      e.preventDefault();e.stopPropagation();
      picked=e.target;
      try{parent.postMessage({type:"shugu:pinPlaced",el:desc(e.target),relX:e.clientX/Math.max(1,window.innerWidth),relY:e.clientY/Math.max(1,window.innerHeight)},"*");}catch(err){}
      return;
    }
    if(!sel)return;e.preventDefault();e.stopPropagation();
    var el=e.target;picked=el;setHov(null);sel=false;try{document.body.style.cursor="";}catch(e3){}
    try{parent.postMessage({type:"shugu:selected",el:desc(el)},"*");}catch(err){}
  },true);
  document.addEventListener("dblclick",function(e){
    if(!editOn)return;
    var el=e.target;
    if(!el||!el.tagName)return;
    if(!ownText(el)){
      var p=el.parentElement,n=0;
      while(p&&n<3&&!ownText(p)){p=p.parentElement;n++;}
      if(p&&ownText(p))el=p;else return;
    }
    e.preventDefault();e.stopPropagation();
    commitEdit(false);
    editing=el;oldText=(el.textContent||"").trim().replace(/\s+/g," ");
    try{el.contentEditable="true";el.focus();}catch(e2){}
  },true);
  document.addEventListener("blur",function(e){if(editing&&e.target===editing)commitEdit(false);},true);
  document.addEventListener("keydown",function(e){
    if(!editing)return;
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();commitEdit(false);}
    else if(e.key==="Escape"){commitEdit(true);}
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

/// Resolve + read a file under `<workspace>/.shugu-forge/preview/`. A missing
/// root `index.html` renders the normal empty Studio state with HTTP 200.
/// Escapes and genuinely missing assets remain 404.
pub fn serve(app: &AppHandle, raw_path: &str) -> Response<Cow<'static, [u8]>> {
    // Decode %xx, drop the leading slash.
    let decoded = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy();
    let rel = decoded.trim_start_matches('/');
    let is_index_request = rel.is_empty() || rel == "index.html";

    // Atelier preview: `__atelier__/<agentId>/<path>` serves from that run's
    // THROWAWAY creation dir under the OS temp dir — the Atelier never writes
    // into the user's workspace, so this path is workspace-independent. Lets
    // the TranscriptDrawer render the web app the agent built + tested.
    if let Some(rest) = rel.strip_prefix("__atelier__/") {
        return serve_atelier(rest);
    }

    // Open-workspace files: `__ws__/<path>` serves from the trusted workspace
    // root (any project the user opened) — Studio atlas pages/assets, not the
    // forge generation silo.
    if let Some(rest) = rel.strip_prefix("__ws__/") {
        return serve_workspace_root(app, rest, is_index_request);
    }
    if rel == "__ws__" || rel == "__ws__/" {
        return serve_workspace_root(app, "index.html", true);
    }

    // Legacy Studio generation silo: <workspace>/.shugu-forge/preview/<path>.
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
            None if is_index_request => return empty_preview(),
            None => return not_found(),
        }
    };
    if !crate::commands::project_trust::is_trusted(app, &root) {
        return if is_index_request {
            empty_preview()
        } else {
            not_found()
        };
    }

    let mut base = root;
    for part in PREVIEW_SUBDIR.split('/') {
        base.push(part);
    }

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

    let canonical_base = match std::fs::canonicalize(&base) {
        Ok(path) => path,
        Err(_) if is_index_request => return empty_preview(),
        Err(_) => return not_found(),
    };
    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(path) => path,
        Err(_) if is_index_request => return empty_preview(),
        Err(_) => return not_found(),
    };
    if !canonical_target.starts_with(&canonical_base) || !canonical_target.is_file() {
        return not_found();
    }
    read_and_respond(&canonical_target)
}

/// Serve a file from the open workspace root (`__ws__/<rel>`). Same trust +
/// path-safety rules as the forge silo, but the base is the project folder
/// itself so Studio can render real pages/assets of whatever is open.
fn serve_workspace_root(
    app: &AppHandle,
    rest: &str,
    is_index_request: bool,
) -> Response<Cow<'static, [u8]>> {
    let root: PathBuf = {
        let state = app.state::<Mutex<Option<PathBuf>>>();
        let guard = match state.lock() {
            Ok(g) => g,
            Err(_) => return not_found(),
        };
        match guard.clone() {
            Some(r) => r,
            None if is_index_request => return empty_preview(),
            None => return not_found(),
        }
    };
    if !crate::commands::project_trust::is_trusted(app, &root) {
        return if is_index_request {
            empty_preview()
        } else {
            not_found()
        };
    }

    let rel = if rest.is_empty() { "index.html" } else { rest };
    let mut target = root.clone();
    for comp in std::path::Path::new(rel).components() {
        match comp {
            Component::Normal(c) => target.push(c),
            Component::CurDir => {}
            _ => return not_found(),
        }
    }

    let canonical_base = match std::fs::canonicalize(&root) {
        Ok(path) => path,
        Err(_) if is_index_request => return empty_preview(),
        Err(_) => return not_found(),
    };
    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(path) => path,
        Err(_) if is_index_request => return empty_preview(),
        Err(_) => return not_found(),
    };
    if !canonical_target.starts_with(&canonical_base) || !canonical_target.is_file() {
        return if is_index_request {
            empty_preview()
        } else {
            not_found()
        };
    }
    read_and_respond(&canonical_target)
}

/// Serve a file from an Atelier run's throwaway creation dir: `rest` is
/// `<agentId>/<path>` (path defaults to index.html). The agent id is validated
/// (alphanumerics + `-` only, matching a UUID) so it can't escape the temp dir,
/// and every sub-path component is checked the same way as the workspace branch.
fn serve_atelier(rest: &str) -> Response<Cow<'static, [u8]>> {
    let mut it = rest.splitn(2, '/');
    let agent_id = it.next().unwrap_or("");
    if agent_id.is_empty()
        || !agent_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return not_found();
    }
    let sub = it.next().unwrap_or("");
    let sub = if sub.is_empty() { "index.html" } else { sub };

    let mut base = std::env::temp_dir();
    base.push(format!("shugu-atelier-{agent_id}"));
    let mut target = base.clone();
    for comp in std::path::Path::new(sub).components() {
        match comp {
            Component::Normal(c) => target.push(c),
            Component::CurDir => {}
            _ => return not_found(),
        }
    }

    let Ok(canonical_base) = std::fs::canonicalize(&base) else {
        return not_found();
    };
    let Ok(canonical_target) = std::fs::canonicalize(&target) else {
        return not_found();
    };
    if !canonical_target.starts_with(&canonical_base) || !canonical_target.is_file() {
        return not_found();
    }
    read_and_respond(&canonical_target)
}

/// Read `target` and build the HTTP response: HTML gets the Studio controller
/// injected (inert in the Atelier, but harmless), everything else is served raw.
fn read_and_respond(target: &std::path::Path) -> Response<Cow<'static, [u8]>> {
    match std::fs::read(target) {
        Ok(bytes) => {
            let mime = guess_mime(target);
            if mime.starts_with("text/html") {
                respond(200, mime, Cow::Owned(inject_controller(&bytes)))
            } else {
                respond(200, mime, Cow::Owned(bytes))
            }
        }
        Err(_) => not_found(),
    }
}

// ---------------------------------------------------------------------------
// Dev-server detection — onglet "Prévisu"
// ---------------------------------------------------------------------------

/// Probe a set of localhost ports and return those currently accepting TCP
/// connections. The Contexte "Prévisu" tab shows its iframe ONLY when a real dev
/// server is running (empty state otherwise). Probes run concurrently, each
/// capped at 150 ms, so a full sweep finishes in well under a second even when
/// every port is closed. No new dependency — tokio is already pulled in.
#[tauri::command]
pub async fn preview_detect_server(ports: Vec<u16>) -> Result<Vec<u16>, String> {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    let mut handles = Vec::with_capacity(ports.len());
    for port in ports {
        handles.push(tokio::spawn(async move {
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
            let ok = tokio::time::timeout(
                Duration::from_millis(150),
                tokio::net::TcpStream::connect(addr),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            (port, ok)
        }));
    }

    let mut open = Vec::new();
    for h in handles {
        if let Ok((port, true)) = h.await {
            open.push(port);
        }
    }
    open.sort_unstable();
    Ok(open)
}

#[cfg(test)]
mod tests {
    use super::{empty_preview, inject_controller, not_found};

    #[test]
    fn empty_studio_entry_is_success_but_missing_assets_remain_not_found() {
        let empty = empty_preview();
        assert_eq!(empty.status(), 200);
        assert!(String::from_utf8_lossy(empty.body()).contains("Aucun projet"));

        let missing = not_found();
        assert_eq!(missing.status(), 404);
    }

    #[test]
    fn controller_is_injected_before_body_close() {
        let html = inject_controller(b"<!doctype html><body>preview</body>");
        let rendered = String::from_utf8(html).unwrap();
        let script = rendered.find("window.__shuguStudio").unwrap();
        let close = rendered.find("</body>").unwrap();
        assert!(script < close);
    }
}
