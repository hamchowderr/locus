import { describe, expect, it } from "vitest";
import { FakeRuntimeProvider } from "./fake.ts";
import { handleSandboxRequest, type SandboxHandlerOptions } from "./handler.ts";
import { InvalidPathError } from "./paths.ts";
import { RemoteRuntimeProvider, RemoteSandboxError, remoteSandboxFromEnv } from "./remote.ts";

const URL_ = "https://locus.test/api/internal/sandbox";
type Principal = { client: string };

function setup(
  overrides: Partial<SandboxHandlerOptions<Principal>> = {},
  opts: { token?: string; maxBodyBytes?: number } = {},
) {
  const fake = new FakeRuntimeProvider({
    handler: (command, args) => {
      if (command === "explode") throw new Error("sandbox exploded: disk full");
      if (command === "echo") return { stdout: args.join(" "), exitCode: 0 };
      if (command === "fail") return { stderr: "nope", exitCode: 2, timedOut: true };
      return undefined;
    },
  });
  const keys: string[] = [];
  const handlerOptions: SandboxHandlerOptions<Principal> = {
    provider: fake,
    authenticate: (token) => (token === "good-token" ? { client: "loc-a" } : null),
    sandboxKey: (principal, siteId) => {
      if (siteId === "other-clients-site") return null;
      const key = `${principal.client}/${siteId}`;
      keys.push(key);
      return key;
    },
    ...(opts.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
    ...overrides,
  };
  const requests: Request[] = [];
  const inProcess: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handleSandboxRequest(request, handlerOptions);
  };
  const remote = new RemoteRuntimeProvider({
    url: URL_,
    mintToken: () => opts.token ?? "good-token",
    fetch: inProcess,
    ...(opts.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
  });
  return { fake, remote, keys, requests, handlerOptions };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good-token", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("RemoteRuntimeProvider through handleSandboxRequest", () => {
  it("round-trips every SiteRuntime operation", async () => {
    const { fake, remote, keys } = setup();
    const runtime = await remote.open("site-1");
    expect(runtime.id).toBe("remote-site-1");
    expect(keys).toEqual(["loc-a/site-1"]);
    const local = fake.runtimes.get("loc-a/site-1");
    if (!local) throw new Error("not opened");

    const bytes = new Uint8Array([0, 1, 2, 255]);
    await runtime.writeFiles([
      { path: "package.json", content: '{"name":"x"}' },
      { path: "./public/logo.bin", content: bytes },
    ]);
    expect(local.readText("package.json")).toBe('{"name":"x"}');
    expect(local.files.get("public/logo.bin")).toEqual(bytes);

    expect(await runtime.run("echo", ["hello", "world"], { timeoutMs: 1234 })).toEqual({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    });
    expect(local.calls).toContainEqual({
      method: "run",
      command: "echo",
      args: ["hello", "world"],
      timeoutMs: 1234,
    });
    expect(await runtime.run("fail")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "nope",
      timedOut: true,
    });

    expect((await runtime.install()).exitCode).toBe(0);
    expect((await runtime.install()).stdout).toBe("dependencies up to date");
    expect(await runtime.startPreview()).toEqual({ url: "https://preview.fake/loc-a/site-1" });
    local.setPreviewLogs("compiled /");
    expect(await runtime.previewLogs()).toBe("compiled /");

    await runtime.deleteFiles(["public"]);
    expect(local.files.has("public/logo.bin")).toBe(false);
    await runtime.stop();
    expect(local.stopped).toBe(true);
    expect(local.previewRunning).toBe(false);
  });

  it("keeps output limits: the runtime's tail comes back as is", async () => {
    const { remote, fake } = setup();
    const runtime = await remote.open("site-1");
    const local = fake.runtimes.get("loc-a/site-1");
    local?.setPreviewLogs("x".repeat(70_000));
    const logs = await runtime.previewLogs();
    expect(logs.startsWith("[... 6000 characters truncated ...]")).toBe(true);
  });

  it("splits a large writeFiles under the body cap and writes every file", async () => {
    const { remote, fake, requests } = setup({}, { maxBodyBytes: 64 * 1024 });
    const runtime = await remote.open("site-1");
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `big/${i}.txt`,
      content: String(i).repeat(20_000),
    }));
    await runtime.writeFiles(files);
    const local = fake.runtimes.get("loc-a/site-1");
    for (const file of files) expect(local?.readText(file.path)).toBe(file.content);
    expect(requests.length).toBeGreaterThan(3);
    await expect(
      runtime.writeFiles([{ path: "huge.txt", content: "y".repeat(100_000) }]),
    ).rejects.toThrow(/over the sandbox endpoint's 65536-byte limit/);
  });

  it("sends the token as a bearer and only the site id, op and args in the body", async () => {
    const { remote, requests } = setup();
    await (await remote.open("site-1")).run("echo", ["a"]);
    const last = requests.at(-1);
    expect(last?.headers.get("authorization")).toBe("Bearer good-token");
    expect(await last?.json()).toEqual({
      siteId: "site-1",
      op: "run",
      args: { command: "echo", args: ["a"] },
    });
  });
});

describe("errors", () => {
  it("keep their messages, without stacks", async () => {
    const { remote } = setup();
    const runtime = await remote.open("site-1");
    const error = await runtime.run("explode").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteSandboxError);
    expect((error as RemoteSandboxError).message).toBe("sandbox exploded: disk full");
    expect((error as RemoteSandboxError).remoteName).toBe("Error");

    const { handlerOptions } = setup();
    const response = await handleSandboxRequest(
      post({ siteId: "s", op: "run", args: { command: "explode" } }),
      handlerOptions,
    );
    const text = await response.text();
    expect(text).not.toMatch(/at .*\.ts:\d+/);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { name: "Error", message: "sandbox exploded: disk full" },
    });
  });

  it("an invalid path comes back as InvalidPathError with the local message", async () => {
    const { remote, handlerOptions } = setup();
    const runtime = await remote.open("site-1");
    const local = await runtime.writeFiles([{ path: "../x", content: "" }]).catch((e) => e);
    expect(local).toBeInstanceOf(InvalidPathError);
    // The server's own check, when a caller skips the client's.
    const response = await handleSandboxRequest(
      post({ siteId: "s", op: "writeFiles", args: { files: [{ path: "/etc/x", content: "" }] } }),
      handlerOptions,
    );
    const body = await response.json();
    expect(body.error).toEqual({
      name: "InvalidPathError",
      message: new InvalidPathError("/etc/x", "absolute paths are not allowed").message,
      path: "/etc/x",
    });
    const fetchServer: typeof fetch = async () => Response.json(body);
    const viaWire = new RemoteRuntimeProvider({
      url: URL_,
      mintToken: () => "t",
      fetch: fetchServer,
    });
    const rebuilt = (await viaWire.call("s", "writeFiles", {}).catch((e) => e)) as InvalidPathError;
    expect(rebuilt).toBeInstanceOf(InvalidPathError);
    expect(rebuilt.message).toBe(body.error.message);
    expect(rebuilt.path).toBe("/etc/x");
  });

  it("open() refuses an empty site key like the local provider", async () => {
    const { remote } = setup();
    await expect(remote.open("")).rejects.toThrow("open() needs a site key");
  });
});

describe("the handler refuses", () => {
  it("a missing, malformed or wrong token, or a non-POST, with the same bare 404", async () => {
    const { handlerOptions } = setup();
    const body = { siteId: "s", op: "open" };
    const responses = await Promise.all([
      handleSandboxRequest(post(body, { authorization: "Bearer wrong" }), handlerOptions),
      handleSandboxRequest(post(body, { authorization: "" }), handlerOptions),
      handleSandboxRequest(post(body, { authorization: "Basic good-token" }), handlerOptions),
      handleSandboxRequest(new Request(URL_, { method: "GET" }), handlerOptions),
      handleSandboxRequest(post(body), {
        ...handlerOptions,
        authenticate: () => {
          throw new Error("bad");
        },
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
    const { remote } = setup({}, { token: "wrong" });
    const error = await remote.open("site-1").catch((e) => e);
    expect(error).toBeInstanceOf(RemoteSandboxError);
    expect(error.status).toBe(404);
  });

  it("a site the principal may not use with 403, before any sandbox opens", async () => {
    const { remote, fake } = setup();
    const error = await remote.open("other-clients-site").catch((e) => e);
    expect(error).toBeInstanceOf(RemoteSandboxError);
    expect(error.status).toBe(403);
    expect(fake.runtimes.size).toBe(0);
  });

  it("an outage in the access check with a bare 500", async () => {
    const { handlerOptions } = setup({
      sandboxKey: () => {
        throw new Error("db password=hunter2 unreachable");
      },
    });
    const response = await handleSandboxRequest(post({ siteId: "s", op: "open" }), handlerOptions);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });

  it("unknown ops and bad args with 400, before any sandbox opens", async () => {
    const { handlerOptions, fake } = setup();
    for (const body of [
      { siteId: "s", op: "exec" },
      { siteId: "s", op: "constructor" },
      { siteId: "s", op: "run", args: { command: "" } },
      { siteId: "s", op: "run", args: { command: "ls", args: [1] } },
      { siteId: "s", op: "run", args: { command: "ls", timeoutMs: -1 } },
      { siteId: "s", op: "writeFiles", args: { files: [{ path: "a" }] } },
      { siteId: "s", op: "deleteFiles", args: { paths: "a" } },
      { siteId: "", op: "open" },
      { op: "open" },
      "not json",
    ]) {
      const response = await handleSandboxRequest(post(body), handlerOptions);
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
    }
    expect(fake.runtimes.size).toBe(0);
  });

  it("an oversized body: 413 once authenticated (stream-bounded), 404 otherwise", async () => {
    const { handlerOptions } = setup({}, { maxBodyBytes: 1024 });
    const big = JSON.stringify({ siteId: "s", op: "open", pad: "x".repeat(5000) });
    expect((await handleSandboxRequest(post(big), handlerOptions)).status).toBe(413);
    // No content-length: the stream is cut off at the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(512).fill(32));
        controller.close();
      },
    });
    const streamed = new Request(URL_, {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await handleSandboxRequest(streamed, handlerOptions)).status).toBe(413);
    const anonymous = post(big, { authorization: "Bearer wrong" });
    expect((await handleSandboxRequest(anonymous, handlerOptions)).status).toBe(404);
  });
});

describe("remoteSandboxFromEnv", () => {
  it("needs LOCUS_SANDBOX_URL and points at the route under it", () => {
    expect(remoteSandboxFromEnv({}, () => "t")).toBeNull();
    expect(remoteSandboxFromEnv({ LOCUS_SANDBOX_URL: " " }, () => "t")).toBeNull();
    const at = (base: string) =>
      remoteSandboxFromEnv({ LOCUS_SANDBOX_URL: base }, () => "t")?.url.toString();
    expect(at("https://locus.example.com")).toBe("https://locus.example.com/api/internal/sandbox");
    expect(at("https://x.example.com/locus/")).toBe(
      "https://x.example.com/locus/api/internal/sandbox",
    );
  });
});
