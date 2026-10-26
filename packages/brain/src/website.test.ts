import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isPublicAddress, pageText, pinnedFetch, publicLookup, readClientPage } from "./website.ts";

const HOME = `<!doctype html><html><head><title>Bright Roofing &amp; Gutters</title>
<meta name="description" content="Roof repair in Austin since 2004.">
<style>.x{color:red}</style><script>window.secret = 1</script></head>
<body><h1>Roof repair</h1><p>From $450. Open 8&nbsp;to 6.</p>
<ul><li>Shingles</li><li>Gutters</li></ul>
<a href="/services">Services</a><a href="https://www.bright.test/faq#top">FAQ</a>
<a href="https://evil.test/x">Elsewhere</a><a href="mailto:hi@bright.test">Mail</a>
</body></html>`;

/** A fake web: each URL's response, and every host resolving to `address`. */
function web(pages: Record<string, () => Response>, address = "93.184.216.34") {
  const asked: string[] = [];
  return {
    asked,
    options: {
      fetch: (async (input: URL | string) => {
        const url = String(input);
        asked.push(url);
        const page = pages[url];
        return page ? page() : new Response("missing", { status: 404 });
      }) as typeof fetch,
      resolve: async () => [address],
    },
  };
}

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("reading the client's website", () => {
  it("gives the page's text, title, description and its own links, without scripts", async () => {
    const { options } = web({ "https://bright.test/": () => html(HOME) });
    const page = await readClientPage("bright.test", "/", options);
    expect(page).toMatchObject({
      url: "https://bright.test/",
      title: "Bright Roofing & Gutters",
      description: "Roof repair in Austin since 2004.",
      links: ["/services", "/faq"],
    });
    const text = "text" in page ? page.text : "";
    expect(text).toContain("# Roof repair");
    expect(text).toContain("From $450. Open 8 to 6.");
    expect(text).toContain("- Shingles");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color:red");
  });

  it("follows a redirect on the site, and refuses one that leaves it", async () => {
    const { options, asked } = web({
      "https://bright.test/old": () =>
        new Response(null, { status: 301, headers: { location: "/services" } }),
      "https://bright.test/services": () => html("<p>Services</p>"),
      "https://bright.test/away": () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(await readClientPage("https://bright.test", "/old", options)).toMatchObject({
      url: "https://bright.test/services",
    });
    expect(await readClientPage("https://bright.test", "/away", options)).toMatchObject({
      error: expect.stringContaining("Only pages on bright.test"),
    });
    expect(asked).not.toContain("http://169.254.169.254/");
  });

  it("never reads another site or a private address", async () => {
    const { options, asked } = web({});
    expect(await readClientPage("bright.test", "https://evil.test/", options)).toMatchObject({
      error: expect.stringContaining("Only pages on bright.test"),
    });
    expect(await readClientPage("bright.test", "//evil.test/x", options)).toHaveProperty("error");
    expect(await readClientPage("bright.test", "file:///etc/passwd", options)).toHaveProperty(
      "error",
    );
    const inside = web({}, "10.0.0.5");
    expect(await readClientPage("bright.test", "/", inside.options)).toMatchObject({
      error: "bright.test isn't on the public internet.",
    });
    expect(await readClientPage("http://127.0.0.1", "/", options)).toMatchObject({
      error: "127.0.0.1 isn't on the public internet.",
    });
    expect([...asked, ...inside.asked]).toEqual([]);
  });

  it("refuses what isn't a web page, and says when the site answers with an error", async () => {
    const { options } = web({
      "https://bright.test/logo.png": () =>
        new Response("png", { headers: { "content-type": "image/png" } }),
    });
    expect(await readClientPage("bright.test", "/logo.png", options)).toMatchObject({
      error: expect.stringContaining("isn't a web page"),
    });
    expect(await readClientPage("bright.test", "/nope", options)).toMatchObject({
      error: "https://bright.test/nope answered 404.",
    });
  });

  it("knows public addresses from private ones", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      // How the URL parser writes [::ffff:127.0.0.1] and [::ffff:169.254.169.254].
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::1",
      "2001:0:4136:e378::1",
      "2001:db8::1",
      "fec0::1",
      "100::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("cuts a very long page", () => {
    const page = pageText(
      `<p>${"word ".repeat(5000)}</p>`,
      new URL("https://bright.test/"),
      "bright.test",
    );
    expect(page.text).toContain("[Cut short here.]");
    expect(page.text.length).toBeLessThan(12_100);
  });

  it("reads hostile markup in time proportional to its size", () => {
    const home = new URL("https://bright.test/");
    for (const junk of ["<!--", "<a ", "<meta ", "<script", "<title", "<a href=x ", "a "]) {
      const started = performance.now();
      pageText(junk.repeat(250_000), home, "bright.test");
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    const odd = pageText("<title>A &#9999999; &amp;lt; B</title><p>x</p>", home, "bright.test");
    expect(odd.title).toBe("A &lt; B");
  });

  it("refuses other ports and a redirect to nonsense", async () => {
    const { options, asked } = web({
      "https://bright.test/bad": () =>
        new Response(null, { status: 302, headers: { location: "http://[::1" } }),
      "https://bright.test/json": () =>
        new Response("{}", { headers: { "content-type": "application/json; x=text/html" } }),
    });
    expect(await readClientPage("bright.test", "https://bright.test:6379/", options)).toMatchObject(
      {
        error: "Only the website's own port can be read, not 6379.",
      },
    );
    expect(await readClientPage("bright.test", "/bad", options)).toHaveProperty("error");
    expect(await readClientPage("bright.test", "/json", options)).toMatchObject({
      error: expect.stringContaining("isn't a web page"),
    });
    expect(asked).not.toContain("https://bright.test:6379/");
  });

  it("connects only to the address it checked, so a name can't answer differently later", async () => {
    const server = createServer((_, res) => res.end("<p>inside</p>"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    let lookups = 0;
    // Public for the check, then the private server for the connection.
    const rebinding = async () => (lookups++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    try {
      const page = await readClientPage(`http://bright.test:${port}`, "/", { resolve: rebinding });
      expect(page).toMatchObject({ error: expect.stringContaining("didn't answer") });
      expect(lookups).toBe(2);
    } finally {
      server.close();
    }
  });

  it("refuses a lookup with any private address", async () => {
    const ask = (addresses: string[]) =>
      new Promise<unknown>((resolve) =>
        publicLookup(async () => addresses)("bright.test", { all: true }, (err, address) =>
          resolve(err ? err.message : address),
        ),
      );
    expect(await ask(["93.184.216.34", "10.0.0.1"])).toBe(
      "bright.test isn't on the public internet.",
    );
    expect(await ask(["93.184.216.34"])).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("survives a site answering a status no browser would", async () => {
    const { createServer: raw } = await import("node:net");
    const server = raw((socket) => socket.end("HTTP/1.1 999 X\r\ncontent-length: 0\r\n\r\n"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    // The transport itself, let through to this one local test server.
    const get = pinnedFetch(
      async () => ["127.0.0.1"],
      (a) => a === "127.0.0.1",
    );
    try {
      const response = await get(`http://bright.test:${port}/`);
      expect(response.status).toBe(502);
    } finally {
      server.close();
    }
  });
});
