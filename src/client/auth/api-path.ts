/**
 * Build the auth API prefix for the deployed base path.
 *
 * Vite's `BASE_URL` is `/` at the root and `/quest/` for a subpath build. The
 * login API must follow the app so a subpath deployment does not accidentally
 * post credentials to the domain root.
 */
export function loginApiPathForBase(baseUrl: string | undefined): string {
  const base = (baseUrl || "/").trim();
  if (!base || base === "." || base === "./") return "/api/auth";
  const normalized = `/${base.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/api/auth" : `${normalized}/api/auth`;
}
