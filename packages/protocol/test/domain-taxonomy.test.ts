// packages/protocol/test/domain-taxonomy.test.ts
// The domain taxonomy: universal AI field domains with metadata. Inference domains are not hand-measured.
import { describe, it, expect } from "vitest";
import { DOMAIN_META, DOMAINS } from "../src/constants";

describe("domain taxonomy", () => {
  it("DOMAIN_META includes the universal AI field", () => {
    expect(Object.keys(DOMAIN_META).length).toBeGreaterThanOrEqual(20);
  });

  it("every DOMAINS value is a key of DOMAIN_META", () => {
    for (const d of DOMAINS) expect(d in DOMAIN_META).toBe(true);
    expect(DOMAINS.length).toBe(Object.keys(DOMAIN_META).length);
  });

  it("reasoning, language, general are inference domains", () => {
    expect(DOMAIN_META.reasoning.observationType).toBe("inference");
    expect(DOMAIN_META.language.observationType).toBe("inference");
    expect(DOMAIN_META.general.observationType).toBe("inference");
  });

  it("measurement domains include the classic eight", () => {
    for (const d of ["compute", "energy", "carbon", "data", "currency", "goods", "code", "science"] as const) {
      expect(DOMAIN_META[d].observationType).toBe("measurement");
    }
  });
  it("multimodal capability domains are inference domains", () => {
    for (const d of ["vision", "audio", "video", "creative", "security", "planning", "multimodal"] as const) {
      expect(DOMAIN_META[d].observationType).toBe("inference");
    }
  });
});
