// Shugu Forge — Profile settings view.
//
// Static stub UI today; will be wired to the real user/preferences store
// in a future phase. Rendered by views-code.tsx as the `profile` section
// of the Settings route.

export function ProfileView() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Profile</h3>
          <p className="sub">Tes informations personnelles. Stockées uniquement localement, jamais transmises sauf appel API explicite.</p>
          <div className="profile-card">
            <div className="avatar">VU</div>
            <div className="info">
              <div className="name">Vincent Ulrich</div>
              <div className="email">vincent@shugu.dev</div>
              <div className="meta">
                <span className="chip primary">Pro</span>
                <span className="chip">macOS 14 · arm64</span>
                <span className="chip success">verified</span>
              </div>
            </div>
            <button className="lgb lgb-sm">Edit</button>
          </div>
        </div>

        <div className="setting-section">
          <h3>Preferences</h3>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Display name</label>
            <div className="input"><input defaultValue="Vincent Ulrich" placeholder="Your name"/></div>
          </div>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Email</label>
            <div className="input"><input defaultValue="vincent@shugu.dev" placeholder="you@domain.com"/></div>
          </div>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Default language</label>
            <div className="input"><input defaultValue="Français (France)"/></div>
          </div>
          <div className="conn-field">
            <label>Default model</label>
            <div className="input"><input defaultValue="shugu-haiku-4-5"/></div>
          </div>
        </div>
      </div>
    </div>
  );
}
