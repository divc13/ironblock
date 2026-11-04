import { describe, expect, it } from "vitest";
import {
  explorerTxUrl,
  isImplicitAccountId,
  loadSettlementConfig,
  parseItemAmount,
  parseRequestId,
  parseTokenId,
} from "../../src/server/settlement/config";
import { SettlementError } from "../../src/server/settlement/errors";

describe("settlement config", () => {
  it("defaults to the final deployed contract and treasury", () => {
    const config = loadSettlementConfig({});
    expect(config.network).toBe("testnet");
    expect(config.contractId).toBe("v2.ironblock-items.testnet");
    expect(config.treasuryAccountId).toBe("v2.ironblock-treasury.testnet");
    expect(config.timeoutMs).toBe(45_000);
    expect(config.rpcUrl).toContain("testnet");
  });

  it("honours env overrides", () => {
    const config = loadSettlementConfig({
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
      NEAR_SETTLEMENT_TIMEOUT_MS: "20000",
      NEAR_TREASURY_KEYSTORE_PATH: "/tmp/treasury.json",
    });
    expect(config.rpcUrl).toBe("https://rpc.testnet.near.org");
    expect(config.timeoutMs).toBe(20_000);
    expect(config.treasuryKeyMode).toBe("keystore");
  });

  it("rejects mainnet and invalid accounts", () => {
    expect(() => loadSettlementConfig({ NEAR_NETWORK: "mainnet" })).toThrow(/testnet-only/i);
    expect(() => loadSettlementConfig({ NEAR_NEP245_CONTRACT_ID: "not an account!" })).toThrow(
      /not a valid NEAR account/i,
    );
    expect(() => loadSettlementConfig({ NEAR_RPC_URL: "http://insecure.example" })).toThrow(
      /https/i,
    );
    expect(() => loadSettlementConfig({ NEAR_SETTLEMENT_TIMEOUT_MS: "100" })).toThrow(/5000\.\.300000/);
  });

  it("classifies implicit accounts", () => {
    expect(isImplicitAccountId("f09b12705f578af820d22da5a5f1bca10ae5fe25cd1a645da6953e2cc5730a57")).toBe(true);
    expect(isImplicitAccountId("v2.ironblock-treasury.testnet")).toBe(false);
    expect(explorerTxUrl("https://explorer.testnet.near.org/transactions/", "abc123")).toBe(
      "https://explorer.testnet.near.org/transactions/abc123",
    );
  });

  it("validates withdrawal inputs", () => {
    expect(() => parseItemAmount("0")).toThrow(/positive integer/i);
    expect(() => parseItemAmount(1.5)).toThrow(/positive integer/i);
    expect(parseItemAmount("25")).toBe(25);
    expect(() => parseRequestId("short")).toThrow(/8\.\.64/);
    expect(parseRequestId("wd_abc-123_def")).toBe("wd_abc-123_def");
    expect(() => parseTokenId("BREAD")).toThrow();
    expect(parseTokenId("iron_ore")).toBe("iron_ore");
    expect(() => parseTokenId(null)).toThrow();
  });

  it("error carries a safe public message", () => {
    const error = new SettlementError("INVALID_REQUEST", 400, "internal detail with secrets)", "Safe message");
    expect(error.publicMessage).toBe("Safe message");
    expect(toPublic(error)).toBe(400);
  });
});

function toPublic(error: SettlementError): number {
  return error.status;
}
