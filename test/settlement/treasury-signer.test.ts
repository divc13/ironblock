import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { loadSettlementConfig } from "../../src/server/settlement/config";
import { createTreasurySigner } from "../../src/server/settlement/treasury-signer";

describe("treasury signer", () => {
  it("creates an inline signer without leaking key material", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const config = loadSettlementConfig({
      NEAR_TREASURY_PRIVATE_KEY: key.toString(),
      NEAR_TREASURY_ACCOUNT_ID: "v2.ironblock-treasury.testnet",
    });

    const result = createTreasurySigner(config);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.source).toBe("inline");

    const signer = result.signer as {
      getPublicKey(accountId: string, networkId: string): Promise<{ toString(): string }>;
      signMessage(message: Uint8Array, accountId: string, networkId: string): Promise<unknown>;
    };
    const publicKey = await signer.getPublicKey(config.treasuryAccountId, config.network);
    expect(publicKey.toString()).toBe(key.getPublicKey().toString());
    await expect(
      signer.signMessage(new Uint8Array([1, 2, 3]), config.treasuryAccountId, config.network),
    ).resolves.toBeDefined();
  });
});
