/**
 * Safe, token-free diagnostics for Auth0 popup failures.
 *
 * Auth0 SPA errors carry their machine-readable code in `error` and the
 * human-readable text in `error_description`/`message`. We deliberately copy
 * only those fields: never spread the original error, which can contain an
 * authorization code, tokens, cookies or a full callback URL.
 */

export interface Auth0FailureDiagnostics {
  name: string;
  code?: string;
  description?: string;
  auth0Error?: string;
  auth0ErrorDescription?: string;
}

const POPUP_MESSAGE =
  "The sign-in popup was closed or blocked. Allow popups and try again.";
const CALLBACK_MESSAGE =
  "Auth0 rejected the callback URL. Check the allowed callback URLs for this origin.";
const GENERIC_MESSAGE = "Sign-in could not be completed. Please try again.";

const CODE_MESSAGES: Record<string, string> = {
  invalid_request: "Auth0 rejected the sign-in request",
  access_denied: "Sign-in was cancelled or access was denied",
  unauthorized_client:
    "This Auth0 application is not authorized for this sign-in",
  invalid_client: "Auth0 rejected the client configuration",
  invalid_grant: "Auth0 rejected the sign-in code or session",
  invalid_scope: "Auth0 rejected the requested sign-in permissions",
  consent_required: "Auth0 requires consent for this sign-in",
  login_required: "Your Auth0 session has expired",
  interaction_required: "Auth0 requires another sign-in step",
  mfa_required: "Auth0 requires multi-factor authentication",
  timeout: "Auth0 sign-in timed out. Close the popup and try again",
  state_mismatch:
    "Auth0 returned an invalid login state. Close the popup and try again",
  popup_open: "The sign-in popup could not be opened. Allow popups and try again",
  cancelled:
    "The sign-in popup was closed or blocked. Allow popups and try again",
};

/** Error fields that can carry an Auth0 code/description without tokens. */
function errorFields(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Auth0's machine-readable code, exposed as `error` (or sometimes `code`). */
export function auth0ErrorCode(error: unknown): string | undefined {
  const fields = errorFields(error);
  return stringField(fields.error) ?? stringField(fields.code);
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return stringField(error.message);
  const fields = errorFields(error);
  return stringField(fields.message) ?? stringField(error);
}

/**
 * Remove token-like material from diagnostic text while keeping enough
 * context to recognise a callback/configuration problem.
 */
export function sanitizeAuth0Text(value: string): string {
  let text = value;

  // Keep the origin/path of a callback URL, but redact sensitive query/hash
  // values. This preserves useful redirect diagnostics without leaking codes.
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveKey(key)) {
          url.searchParams.set(key, "[redacted]");
          changed = true;
        }
      }
      if (url.hash) {
        url.hash = "#[redacted]";
        changed = true;
      }
      return changed ? url.toString() : raw;
    } catch {
      return "[url]";
    }
  });

  // Redact key=value fragments that are not part of a parseable absolute URL.
  text = text.replace(
    /\b([a-z0-9_]*(?:code|token|secret|session|state|nonce|password|email|hint)[a-z0-9_]*)=([^&\s,;"']+)/gi,
    "$1=[redacted]",
  );

  // Redact a bare authorization code when an error description mentions one.
  // Requiring a digit or a long value avoids hiding words like "code
  // challenge" while still catching real Auth0 codes.
  text = text.replace(
    /\b(authorization code|auth code|code)[\s:=]+([A-Za-z0-9._~+/=-]{6,})/gi,
    (match, label: string, value: string) =>
      /\d/.test(value) || value.length >= 16
        ? `${label} [redacted]`
        : match,
  );

  // Bearer tokens and JWT-shaped strings.
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[token]",
  );

  // Email addresses are personal data and must not reach the console.
  text = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[email]",
  );

  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function isSensitiveKey(key: string): boolean {
  return /(code|token|secret|session|state|nonce|password|email|hint)/i.test(
    key,
  );
}

/**
 * Build a small object containing only safe Auth0 error fields.
 *
 * `description` prefers Auth0's `error_description`; `message` is used as the
 * fallback for SDK errors such as `PopupTimeoutError` ("Timeout").
 */
export function describeAuth0Error(error: unknown): Auth0FailureDiagnostics {
  const fields = errorFields(error);
  const code = auth0ErrorCode(error);
  const rawAuth0Error = stringField(fields.error);
  const rawAuth0Description = stringField(fields.error_description);
  const rawMessage = errorMessage(error);
  const rawDescription = rawAuth0Description ?? rawMessage;

  const diagnostics: Auth0FailureDiagnostics = {
    name:
      (error instanceof Error && stringField(error.name)) ||
      (typeof fields.name === "string" ? fields.name : "Error"),
  };

  if (code) diagnostics.code = sanitizeAuth0Text(code);
  if (rawDescription) {
    diagnostics.description = sanitizeAuth0Text(rawDescription);
  }
  if (rawAuth0Error) {
    diagnostics.auth0Error = sanitizeAuth0Text(rawAuth0Error);
  }
  if (rawAuth0Description) {
    diagnostics.auth0ErrorDescription = sanitizeAuth0Text(
      rawAuth0Description,
    );
  }

  return diagnostics;
}

/** Log a concise, token-free Auth0 failure object for the browser console. */
export function logAuth0LoginFailure(error: unknown): void {
  console.error(
    "[ironblock] Auth0 login failed",
    describeAuth0Error(error),
  );
}

function withCode(message: string, code?: string): string {
  if (!code) return /\.$/.test(message) ? message : `${message}.`;
  return `${message.replace(/\.+$/, "")} (${sanitizeAuth0Text(code)}).`;
}

/**
 * Convert an Auth0/SDK error into player-facing text. Common Auth0 codes get
 * a specific explanation and always include the code in parentheses; the
 * popup-blocked and callback-mismatch messages are preserved.
 */
export function readableAuth0Error(error: unknown): string {
  const fields = errorFields(error);
  const code = auth0ErrorCode(error);
  const message = errorMessage(error);
  const description = stringField(fields.error_description) ?? message;
  const searchable = `${code ?? ""} ${description ?? ""} ${message ?? ""}`;

  if (/popup|window|closed/i.test(searchable)) {
    return withCode(POPUP_MESSAGE, code);
  }
  if (/callback|redirect/i.test(searchable)) {
    return withCode(CALLBACK_MESSAGE, code);
  }
  if (code && CODE_MESSAGES[code]) {
    return withCode(CODE_MESSAGES[code], code);
  }
  if (code) {
    return `Sign-in failed (${sanitizeAuth0Text(code)}). Please try again.`;
  }
  return GENERIC_MESSAGE;
}
