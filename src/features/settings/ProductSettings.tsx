import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/trust";
import { ModelPicker } from "@/features/panels/ModelPicker";
import { useActiveModel } from "@/features/chat/chat-sync";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { useModelCapabilities } from "@/lib/modelCapabilities";
import { IMAGE_MODEL_PRESETS } from "@/lib/imageProviders";
import { db } from "@/lib/db";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="label">{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-label={label}
      aria-checked={on}
      data-on={on ? "true" : "false"}
      onClick={() => onChange(!on)}
    />
  );
}

export function GeneralSettings() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Général</h3>
          <p className="sub">État effectif de l’application — aucun réglage décoratif sans backend.</p>
          <Row label="Runtime" desc="Application desktop native ; le serveur Vite seul ne fournit ni IPC ni base.">
            <span className="chip success">Tauri uniquement</span>
          </Row>
          <Row label="Données" desc="Conversations, projets, agents, settings et générations utilisent la base locale.">
            <span className="chip success">SQLite · local-first</span>
          </Row>
          <Row label="Synchronisation cloud" desc="Aucun miroir distant n’est requis ni actif par défaut.">
            <span className="chip">désactivée</span>
          </Row>
          <Row label="Permissions agents" desc="Chat, Plan, Auto sandboxé et Full Access confirmé nativement se règlent depuis le sélecteur de mode du chat.">
            <span className="chip primary">contrôle natif</span>
          </Row>
        </div>
      </div>
    </div>
  );
}

function CapabilitySummary({ modelId }: { modelId: string }) {
  const caps = useModelCapabilities(modelId);
  if (!caps) return <span className="chip">probe…</span>;
  return (
    <span className={"chip " + (caps.agentLoop === "chatOnly" ? "warn" : "success")}>
      {caps.agentLoop === "chatOnly"
        ? "chat uniquement"
        : caps.agentLoop === "compatible"
          ? "agent compatible"
          : "agent natif"}
    </span>
  );
}

export function ModelSettings() {
  const [model, setModel] = useActiveModel();
  const { data: models, errors, isLoading, refresh } = useDiscoveredModels();
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Modèles de langage</h3>
          <p className="sub">La liste vient exclusivement des providers configurés et réellement probés.</p>
          <Row label="Modèle actif" desc="Utilisé par le chat et comme repli orchestrateur quand aucun routage distinct n’est configuré.">
            <ModelPicker model={model} onChange={setModel} className="composer-model" />
          </Row>
          <Row label="Capacité agentique" desc="Calculée par la matrice native ; un modèle Chat-only ne peut pas lancer un run mutatif.">
            {model ? <CapabilitySummary modelId={model} /> : <span className="chip warn">aucun modèle</span>}
          </Row>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <span className="sub">{isLoading ? "Probe en cours…" : `${models.length} modèle(s) disponible(s)`}</span>
            <button className="lgb lgb-sm" onClick={() => void refresh()} disabled={isLoading}>Re-prober</button>
          </div>
          {Object.entries(errors).map(([provider, error]) => (
            <div key={provider} role="alert" style={{ marginTop: 8, color: "var(--error)", fontSize: 11 }}>
              {provider} · {error}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const IMAGE_DEFAULT_KEY = "image.defaultModel";

export function ImageSettings() {
  const fallback = IMAGE_MODEL_PRESETS[0]?.id ?? "comfyui/v1-5-pruned-emaonly.safetensors";
  const [model, setModel] = useState(fallback);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    void db.settings.get(IMAGE_DEFAULT_KEY).then((value) => {
      if (alive && value) setModel(value);
    });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    await db.settings.set(IMAGE_DEFAULT_KEY, model.trim() || fallback);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Génération d’image</h3>
          <p className="sub">Ce réglage est consommé par le Studio Image à son ouverture.</p>
          <div className="conn-field">
            <label>Modèle par défaut</label>
            <select className="lgi lgi-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {IMAGE_MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label} · {preset.provider}</option>
              ))}
            </select>
          </div>
          <div className="conn-field" style={{ marginTop: 10 }}>
            <label>Identifiant personnalisé</label>
            <div className="input">
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" />
            </div>
          </div>
          <button className="lgb lgb-primary" style={{ marginTop: 12 }} onClick={() => void save()}>
            {saved ? "Enregistré ✓" : "Enregistrer"}
          </button>
          <p className="sub" style={{ marginTop: 10 }}>Upscale automatique, watermark C2PA et filtre NSFW ne sont pas exposés : aucun pipeline effectif ne les applique encore.</p>
        </div>
      </div>
    </div>
  );
}

export function PrivacySettings() {
  const [capture, setCapture] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    let alive = true;
    void db.settings.get("agents.allowScreenCapture").then((value) => {
      if (alive) setCapture(value !== "false");
    });
    return () => { alive = false; };
  }, []);
  const setScreenCapture = (on: boolean) => {
    setCapture(on);
    void db.settings.set("agents.allowScreenCapture", on ? "true" : "false");
  };
  const clearAll = async () => {
    setConfirmClear(false);
    setClearing(true);
    try {
      await db.clearAll();
      await queryClient.invalidateQueries();
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Confidentialité</h3>
          <p className="sub">Les appels aux providers configurés quittent la machine ; les données de travail restent locales sauf action explicite de l’agent.</p>
          <Row label="Télémétrie Shugu" desc="Aucun collecteur de télémétrie produit n’est branché."><span className="chip success">désactivée</span></Row>
          <Row label="Historique" desc="SQLite locale. Shugu ne chiffre pas actuellement le fichier de base lui-même ; protège le disque avec BitLocker/FileVault/LUKS."><span className="chip warn">local · non chiffré par Shugu</span></Row>
          <Row label="Captures d’écran des agents" desc="Retire capture_screen du manifest et revérifie le réglage au dispatch.">
            <Toggle on={capture} onChange={setScreenCapture} label="Autoriser les captures d’écran des agents" />
          </Row>
          <Row label="Effacer toutes les données" desc="Supprime conversations, générations, projets, jobs, logs et agents ; conserve les settings et clés.">
            <button className="lgb" style={{ color: "var(--danger)" }} disabled={clearing} onClick={() => setConfirmClear(true)}>
              {clearing ? "Effacement…" : "Effacer"}
            </button>
          </Row>
        </div>
      </div>
      <ConfirmDialog
        open={confirmClear}
        title="Effacer TOUTES les données ?"
        body={<>Cette opération est définitive. Crée une sauvegarde depuis Opérations si tu veux pouvoir restaurer les données.</>}
        confirmLabel="Tout effacer"
        tone="danger"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}

interface DiagFact { label: string; value: string }
interface DiagBundle { facts: DiagFact[]; generatedAt: number }

export function AboutSettings() {
  const [facts, setFacts] = useState<DiagFact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      const bundle = await invoke<DiagBundle>("shugu_diag_bundle", { subsystemsJson: null });
      setFacts(bundle.facts);
    } catch (err) {
      setError(String(err));
    }
  };
  useEffect(() => { void load(); }, []);
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>À propos</h3>
          <p className="sub">Valeurs lues du binaire Tauri et de la base en cours — aucune plateforme codée en dur.</p>
          {facts.map((fact) => (
            <Row key={fact.label} label={fact.label}><span className="chip">{fact.value}</span></Row>
          ))}
          {error && <div role="alert" style={{ color: "var(--error)", fontSize: 11 }}>{error}</div>}
          <button className="lgb lgb-sm" onClick={() => void load()}>Actualiser</button>
        </div>
      </div>
    </div>
  );
}
