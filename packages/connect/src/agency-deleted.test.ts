import { MemorySecretStore } from "@locus/secrets";
import { describe, expect, it } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import { deleteAgencySecrets } from "./agency-deleted.ts";
import { vercelSecretRef } from "./vercel.ts";

describe("deleting an agency's sealed credentials", () => {
  it("removes its GHL and Vercel tokens and leaves other agencies' alone", async () => {
    const secrets = new MemorySecretStore();
    for (const agency of ["agency-a", "agency-b"]) {
      await secrets.set(ghlSecretRef(agency), `ghl-${agency}`);
      await secrets.set(vercelSecretRef(agency), `vercel-${agency}`);
    }

    await deleteAgencySecrets(secrets, "agency-a");

    expect(await secrets.get(ghlSecretRef("agency-a"))).toBeUndefined();
    expect(await secrets.get(vercelSecretRef("agency-a"))).toBeUndefined();
    expect(await secrets.get(ghlSecretRef("agency-b"))).toBe("ghl-agency-b");
    expect(await secrets.get(vercelSecretRef("agency-b"))).toBe("vercel-agency-b");
  });

  it("is safe to run again, or for an agency that never connected anything", async () => {
    const secrets = new MemorySecretStore();
    await expect(deleteAgencySecrets(secrets, "agency-a")).resolves.toBeUndefined();
    await expect(deleteAgencySecrets(secrets, "agency-a")).resolves.toBeUndefined();
  });
});
