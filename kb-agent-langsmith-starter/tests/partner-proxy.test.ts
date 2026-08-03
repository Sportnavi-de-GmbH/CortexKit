import { describe, it, expect, vi } from "vitest";
import { proxyToPartner, isForwardablePath, withKeepAlive } from "../lib/partner-proxy";

describe("withKeepAlive", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  }

  it("passes the upstream bytes through unchanged", async () => {
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: one\n\n"));
        c.close();
      },
    });
    expect(await drain(withKeepAlive(src, 10_000))).toBe("data: one\n\n");
  });

  it("injects an SSE comment while the upstream is silent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const src = new ReadableStream<Uint8Array>({
      async start(c) {
        await gate; // upstream stays silent (a long tool call)
        c.enqueue(new TextEncoder().encode("data: late\n\n"));
        c.close();
      },
    });
    const out = withKeepAlive(src, 5); // tiny interval so the test is fast
    const reader = out.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
    release();
    await reader.cancel();
  });
});

describe("isForwardablePath", () => {
  it("allows eve routes", () => {
    expect(isForwardablePath(["eve", "v1", "session"])).toBe(true);
    expect(isForwardablePath(["eve"])).toBe(true);
  });
  it("rejects non-eve paths", () => {
    expect(isForwardablePath(["admin"])).toBe(false);
    expect(isForwardablePath(["..", "etc", "passwd"])).toBe(false);
  });
});

describe("proxyToPartner", () => {
  const req = (method: string, url = "http://localhost/api/partner/eve/v1/session") =>
    new Request(url, method === "POST" ? { method, body: "{}" } : { method });

  it("returns 503 when no host is configured", async () => {
    const res = await proxyToPartner(req("GET"), ["eve", "v1", "session"], { host: "" });
    expect(res.status).toBe(503);
  });

  it("returns 404 for non-eve paths", async () => {
    const res = await proxyToPartner(
      req("GET", "http://localhost/api/partner/admin"),
      ["admin"],
      { host: "http://partner.local" },
    );
    expect(res.status).toBe(404);
  });

  it("forwards eve requests to the partner host and streams the upstream body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("data: hi\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const res = await proxyToPartner(req("POST"), ["eve", "v1", "session"], {
      host: "http://partner.local",
      fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://partner.local/eve/v1/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await res.text()).toBe("data: hi\n\n");
  });

  it("does not forward content-encoding (fetch already decoded the body)", async () => {
    // Node fetch auto-decompresses; forwarding the stale content-encoding header
    // makes the browser try to gunzip plain text → 'Failed to fetch'.
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 202,
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        }),
    ) as unknown as typeof fetch;

    const res = await proxyToPartner(req("POST"), ["eve", "v1", "session"], {
      host: "http://partner.local",
      fetchImpl,
    });

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe('{"ok":true}');
  });
});
