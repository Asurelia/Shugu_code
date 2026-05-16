// Shugu Forge — secure credential storage backed by the OS-native keychain.
//
// All secret material the UI captures (provider API keys, OAuth tokens, etc.)
// goes through this module. On Windows we land in Credential Manager
// ("Generic Credentials"), on macOS in Keychain, on Linux in Secret Service.
//
// Design notes:
//
// * SERVICE is a constant ("shugu-forge") so every credential lives under a
//   single namespace that the user can audit from their OS settings.
//
// * `account` is the only caller-supplied discriminator. The frontend uses
//   a hierarchical convention like "provider.anthropic.apiKey" so multiple
//   secret kinds per provider remain disambiguated without a second table.
//
// * `cred_get` returns Option<String> rather than erroring on absence so the
//   common "no key yet, render the field empty" path is not a `try/catch`
//   on the JS side. Real I/O failures still bubble up as `Err`.
//
// * `cred_delete` is idempotent on the not-found case (returns Ok) — same
//   rationale: "Disconnect" should succeed even if the key was never set.
//
// We do NOT store baseUrl / orgId / endpoint here — those are non-secret
// configuration and live in the SQLite `settings` table (LOCAL-FIRST mandate,
// see CLAUDE.md). Keeping the split clean lets a future Convex sync layer
// safely replicate `settings` while never touching the OS keychain.

use keyring::Entry;

const SERVICE: &str = "shugu-forge";

/// Persist a secret in the OS-native credential store under
/// (SERVICE, `account`). Overwrites any prior value for that account.
#[tauri::command]
pub fn cred_set(account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

/// Read a secret from the OS-native credential store. Returns `Ok(None)`
/// when no credential exists for the given `account` so callers can branch
/// on absence without try/catch noise. Other errors (locked keychain, OS
/// failure) propagate as `Err`.
#[tauri::command]
pub fn cred_get(account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a secret. Idempotent on the not-found case — "Disconnect" should
/// succeed whether or not a key was previously stored.
#[tauri::command]
pub fn cred_delete(account: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
