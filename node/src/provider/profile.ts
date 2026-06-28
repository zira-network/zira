// node/src/provider/profile.ts
// Build and sign a ProviderProfile (Tier 2 capability advertisement). The profile is gossiped as
// authenticated soft state; ZTI, not the self reported numbers here, reflects real answer quality.
import { signRecord, DOMAINS, type Keypair, type ProviderProfile, type ProviderConfig } from "@zira/protocol";

export function buildProviderProfile(
  identity: Keypair,
  config: ProviderConfig,
  measured: { tokensPerSec: number; contextWindowTokens: number },
): ProviderProfile {
  const draft = {
    address: identity.address,
    label: config.label || `${identity.address.slice(0, 12)}... provider`,
    domains: config.domains.length > 0 ? config.domains : DOMAINS,
    tokensPerSec: measured.tokensPerSec,
    contextWindowTokens: measured.contextWindowTokens,
    supportsStreaming: config.supportsStreaming,
    modelHint: config.endpointModel,
    updatedAt: Date.now(),
  };
  return signRecord(draft, identity.privateKey);
}
