//! Lot C — client MCP (Model Context Protocol).
//!
//! Lance de vrais serveurs MCP (stdio local ou HTTP/SSE distant) via le SDK
//! `rmcp`, découvre leurs outils (`tools/list`) renommés `mcp__<server>__<tool>`,
//! et les exécute (`tools/call`). Les boucles d'outils du chat et des agents
//! concatènent ces outils (pour les serveurs ACTIVÉS) à leur schéma natif.
//!
//! Sûreté : un serveur n'est lancé ni exposé que s'il est explicitement activé
//! (`mcp.<server>.enabled` ≠ "false" dans la table settings ; défaut OFF).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Un serveur MCP tel que déclaré dans `.mcp.json`. `command`(+args/env) ⇒
/// transport stdio ; `url` ⇒ transport HTTP/SSE. Les deux sont mutuellement
/// exclusifs (un serveur est local OU distant).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl McpServerConfig {
    /// "stdio" si `command` présent, "http" si `url`, sinon "invalid".
    pub fn transport(&self) -> &'static str {
        if self.command.is_some() {
            "stdio"
        } else if self.url.is_some() {
            "http"
        } else {
            "invalid"
        }
    }
}

/// Le fichier `.mcp.json` : `{ "mcpServers": { "name": {…} } }`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct McpConfigFile {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
}

/// Parse un `.mcp.json` (texte). Tolère un fichier vide/absent → config vide.
pub fn parse_mcp_config(text: &str) -> Result<McpConfigFile, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(McpConfigFile::default());
    }
    serde_json::from_str::<McpConfigFile>(t).map_err(|e| format!("`.mcp.json` invalide : {e}"))
}

/// Merge projet (prioritaire) sur global : un serveur de même nom côté projet
/// écrase celui du global.
pub fn merge_configs(global: McpConfigFile, project: McpConfigFile) -> McpConfigFile {
    let mut out = global;
    for (name, cfg) in project.mcp_servers {
        out.mcp_servers.insert(name, cfg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_is_empty() {
        assert!(parse_mcp_config("").unwrap().mcp_servers.is_empty());
        assert!(parse_mcp_config("   \n").unwrap().mcp_servers.is_empty());
    }

    #[test]
    fn parse_stdio_and_http() {
        let json = r#"{
          "mcpServers": {
            "fs":     { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] },
            "remote": { "url": "https://example.com/mcp" }
          }
        }"#;
        let c = parse_mcp_config(json).unwrap();
        assert_eq!(c.mcp_servers.len(), 2);
        assert_eq!(c.mcp_servers["fs"].transport(), "stdio");
        assert_eq!(c.mcp_servers["fs"].command.as_deref(), Some("npx"));
        assert_eq!(c.mcp_servers["remote"].transport(), "http");
    }

    #[test]
    fn parse_invalid_errors() {
        assert!(parse_mcp_config("{ not json").is_err());
    }

    #[test]
    fn merge_project_overrides_global() {
        let global = parse_mcp_config(r#"{"mcpServers":{"a":{"command":"old"},"b":{"command":"keep"}}}"#).unwrap();
        let project = parse_mcp_config(r#"{"mcpServers":{"a":{"command":"new"}}}"#).unwrap();
        let m = merge_configs(global, project);
        assert_eq!(m.mcp_servers.len(), 2);
        assert_eq!(m.mcp_servers["a"].command.as_deref(), Some("new"));
        assert_eq!(m.mcp_servers["b"].command.as_deref(), Some("keep"));
    }
}
