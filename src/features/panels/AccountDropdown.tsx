// Shugu Forge — account dropdown (titlebar avatar popover).
//
// Static UI today; will read user + plan info from a real auth source in
// a future phase. Rendered by RootLayout above the window chrome and
// triggered by the avatar in the title bar.

import { Icon } from "@/components/components";

export function AccountDropdown({ open, onClose, onView }: any) {
  if (!open) return null;
  return (
    <>
      <div style={{position:"fixed",inset:0,zIndex:199}} onClick={onClose}/>
      <div className="account-pop">
        <div className="account-head">
          <div className="avatar">VU</div>
          <div className="who">
            <div className="name">Vincent Ulrich</div>
            <div className="email">vincent@shugu.dev</div>
          </div>
          <button className="dock-act" title="Edit profile"><Icon name="gear" size={13}/></button>
        </div>

        <div className="account-tier">
          <span className="badge">Pro</span>
          <div className="info">
            <div className="l">Plan</div>
            <div className="v">Shugu Pro · <small>renews May 30</small></div>
          </div>
        </div>

        <div className="account-usage">
          <div className="row"><span>Chat tokens</span><span className="v">128k / 500k</span></div>
          <div className="bar"><div className="fill" style={{width:"26%"}}></div></div>
          <div className="row" style={{marginTop:8}}><span>Image credits</span><span className="v">42 / 200</span></div>
          <div className="bar"><div className="fill" style={{width:"21%"}}></div></div>
        </div>

        <div className="account-menu">
          <button className="account-item" onClick={() => { onView("profile"); onClose(); }}>
            <span className="ico"><Icon name="agent" size={13}/></span>Account & Profile
          </button>
          <button className="account-item" onClick={() => { onView("connections"); onClose(); }}>
            <span className="ico"><Icon name="folder" size={13}/></span>Connections & API keys
          </button>
          <button className="account-item" onClick={() => { onView("privacy"); onClose(); }}>
            <span className="ico"><Icon name="shield" size={13}/></span>Privacy & data
          </button>
          <button className="account-item">
            <span className="ico"><Icon name="copy" size={13}/></span>Billing & invoices
          </button>
          <button className="account-item">
            <span className="ico"><Icon name="sparkle" size={13}/></span>Switch theme
          </button>
          <div className="ctx-divider"></div>
          <button className="account-item">
            <span className="ico"><Icon name="search" size={13}/></span>Help & support
          </button>
          <button className="account-item danger">
            <span className="ico"><Icon name="x" size={13}/></span>Sign out
          </button>
        </div>
      </div>
    </>
  );
}
