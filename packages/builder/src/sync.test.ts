import { FakeRuntime } from "@locus/sandbox";
import { PREVIEW_DEV_HOSTS } from "@locus/studio";
import { describe, expect, it } from "vitest";
import { syncRuntime } from "./sync.ts";

const draft = [
  { path: "package.json", content: '{"name":"site"}' },
  { path: "next.config.ts", content: "export default {};\n" },
  { path: "app/page.tsx", content: "export default function Page() { return null; }\n" },
];

const previewConfig = (runtime: FakeRuntime) => String(runtime.files.get("next.config.ts"));

describe("syncRuntime", () => {
  it("lets next dev answer on Vercel Sandbox's preview hosts by default", async () => {
    const runtime = new FakeRuntime("site");
    await syncRuntime(runtime, draft);
    expect(previewConfig(runtime)).toContain(JSON.stringify(PREVIEW_DEV_HOSTS));
    expect(runtime.files.get("next.config.site.ts")).toBe("export default {};\n");
  });

  it("uses the hosts the runtime's own service serves previews on", async () => {
    // As a Daytona runtime reports them (`DAYTONA_PREVIEW_HOSTS`).
    const runtime = Object.assign(new FakeRuntime("site"), {
      previewHosts: ["*.proxy.daytona.works"],
    });
    await syncRuntime(runtime, draft);
    expect(previewConfig(runtime)).toContain('["*.proxy.daytona.works"]');
    expect(previewConfig(runtime)).not.toContain("vercel.run");
  });
});
