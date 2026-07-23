// Shugu Forge — Trust-UX primitives barrel (Lane 5).
//
// Confidence components that make the agent's real capabilities legible:
// risk tiers, permission facts, execution profiles, confirmations, notices,
// and per-message mode badges. Import from "@/components/trust".

export { RiskBadge } from "./RiskBadge";
export { PermissionBadge, type PermissionKind } from "./PermissionBadge";
export { InlineNotice, type NoticeTone } from "./InlineNotice";
export { ConfirmDialog } from "./ConfirmDialog";
export { useConfirm, type ConfirmOptions } from "./useConfirm";
export { ExecutionProfileCard, type SafetyNet } from "./ExecutionProfileCard";
export { ModeBadge } from "./ModeBadge";
export {
  RISK,
  MODE_META,
  modeToRisk,
  toTrustMode,
  type RiskLevel,
  type RiskMeta,
  type TrustMode,
  type ModeMeta,
} from "./trust";
