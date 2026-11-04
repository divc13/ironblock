import { describe, expect, it, vi } from "vitest";
import {
  describeAuth0Error,
  logAuth0LoginFailure,
  readableAuth0Error,
} from "../../src/client/auth/auth0-errors";

interface Auth0ErrorShape extends Error {
  error?: string;
  error_description?: string;
}

function auth0Error(
  code: string,
  description: string,
  message = description,
): Auth0ErrorShape {
  const error = new Error(message) as Auth0ErrorShape;
  error.error = code;
  error.error_description = description;
  return error;
}

describe("readableAuth0Error", () => {
  it("keeps the popup-blocked message", () => {
    const error = new Error("Popup closed");
    expect(readableAuth0Error(error)).toBe(
      "The sign-in popup was closed or blocked. Allow popups and try again.",
    );
  });

  it("adds the Auth0 code to the popup message", () => {
    expect(readableAuth0Error(auth0Error("cancelled", "Popup closed"))).toBe(
      "The sign-in popup was closed or blocked. Allow popups and try again (cancelled).",
    );
  });

  it("keeps the callback-mismatch message", () => {
    const error = new Error(
      "Callback URL mismatch. The redirect_uri is not in the allowed list.",
    );
    expect(readableAuth0Error(error)).toBe(
      "Auth0 rejected the callback URL. Check the allowed callback URLs for this origin.",
    );
  });

  it("explains a timed-out popup instead of falling back to the generic text", () => {
    expect(readableAuth0Error(auth0Error("timeout", "Timeout"))).toBe(
      "Auth0 sign-in timed out. Close the popup and try again (timeout).",
    );
  });

  it("includes common Auth0 codes in parentheses", () => {
    expect(readableAuth0Error(auth0Error("access_denied", "User cancelled"))).toBe(
      "Sign-in was cancelled or access was denied (access_denied).",
    );
    expect(
      readableAuth0Error(
        auth0Error("invalid_request", "The request is missing a parameter"),
      ),
    ).toBe("Auth0 rejected the sign-in request (invalid_request).");
  });

  it("uses the callback mapping when invalid_request mentions redirect_uri", () => {
    expect(
      readableAuth0Error(
        auth0Error(
          "invalid_request",
          "The redirect_uri http://localhost:3000 is not allowed",
        ),
      ),
    ).toBe(
      "Auth0 rejected the callback URL. Check the allowed callback URLs for this origin (invalid_request).",
    );
  });

  it("mentions an unknown code without hiding it", () => {
    expect(readableAuth0Error(auth0Error("weird_code", "Something odd"))).toBe(
      "Sign-in failed (weird_code). Please try again.",
    );
  });

  it("falls back to the generic message when no code or mapping exists", () => {
    expect(readableAuth0Error(new Error("Network unavailable"))).toBe(
      "Sign-in could not be completed. Please try again.",
    );
    expect(readableAuth0Error("not an error")).toBe(
      "Sign-in could not be completed. Please try again.",
    );
  });
});

describe("describeAuth0Error", () => {
  it("keeps only the safe Auth0 fields", () => {
    const error = auth0Error(
      "invalid_request",
      "The redirect_uri http://localhost:3000 is not allowed",
    );
    error.name = "AuthenticationError";

    expect(describeAuth0Error(error)).toEqual({
      name: "AuthenticationError",
      code: "invalid_request",
      description:
        "The redirect_uri http://localhost:3000 is not allowed",
      auth0Error: "invalid_request",
      auth0ErrorDescription:
        "The redirect_uri http://localhost:3000 is not allowed",
    });
  });

  it("redacts codes, tokens, emails and URL query values", () => {
    const error = auth0Error(
      "invalid_grant",
      "Authorization code xyz123 for user@example.com was rejected; access_token=secret-token",
    );
    error.message =
      "Failed at https://localhost:3000/callback?code=abc123&state=state456#session";

    const diagnostics = describeAuth0Error(error);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.code).toBe("invalid_grant");
    expect(serialized).not.toContain("xyz123");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("state456");
    expect(serialized).not.toContain("#session");
    expect(serialized).toContain("[email]");
    expect(serialized).toContain("[redacted]");
  });

  it("logs a concise token-free object under the ironblock prefix", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = auth0Error(
        "access_denied",
        "User user@example.com denied access with code=abc123",
      );
      logAuth0LoginFailure(error);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("[ironblock] Auth0 login failed");
      const logged = JSON.stringify(spy.mock.calls[0][1]);
      expect(logged).toContain("access_denied");
      expect(logged).not.toContain("user@example.com");
      expect(logged).not.toContain("abc123");
    } finally {
      spy.mockRestore();
    }
  });
});
