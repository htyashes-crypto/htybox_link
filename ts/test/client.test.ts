import { describe, expect, it } from "vitest";
import { DaemonClient, type Transport } from "../src/client";

describe("DaemonClient request timeout", () => {
  it("无响应时按 requestTimeoutMs reject（spec §10）", async () => {
    const transport: Transport = {
      send() {},
      onMessage() {},
      onClose() {},
      close() {},
    };
    const client = new DaemonClient(transport, {
      clientId: "t",
      clientType: "cli",
      appVersion: "t",
      requestTimeoutMs: 50,
    });
    await expect(client.request("terminal.list", {})).rejects.toThrow(/超时/);
  });
});
