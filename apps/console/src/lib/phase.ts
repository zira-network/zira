import type { NetworkPhase } from "@zira/protocol";

// Phase gates which features are on. Founder tools are gated separately by the node's identity,
// not here. Upcoming features (anchors, governance, ZRC-1 objects, intelligent agreements) are off
// in every phase. Their pages render a "coming soon" banner so the roadmap stays visible.
export type Feature =
  | "earning" | "settlement" | "resonators" | "marketplace"
  | "inference_provider" | "zti_dashboard" | "notification_center"
  | "query_fusion_explorer" | "resonator_analytics"
  | "anchors_active" | "governance" | "zrc1_objects" | "intelligent_agreements";

// Phases in which a feature is enabled. Empty = never (coming soon).
const FEATURE_PHASES: Record<Feature, NetworkPhase[]> = {
  earning: ["first_release", "live"],
  settlement: ["live"],
  resonators: ["first_release", "live"],
  marketplace: ["live"],
  inference_provider: ["first_release", "live"],
  zti_dashboard: ["first_release", "live"],
  notification_center: ["first_release", "live"],
  query_fusion_explorer: ["live"],
  resonator_analytics: ["live"],
  anchors_active: [],
  governance: [],
  zrc1_objects: [],
  intelligent_agreements: [],
};

export function featureEnabled(phase: NetworkPhase, feature: Feature): boolean {
  return FEATURE_PHASES[feature]?.includes(phase) ?? false;
}

export function phaseLabel(phase: NetworkPhase): string {
  return phase === "formation" ? "Formation" : phase === "first_release" ? "First release" : "Live";
}
