import { Assistant, KeelProvider, ShadowRoot } from "@keel/react";

/**
 * The Keel assistant, embedded in Northwind Cloud.
 *
 * The identity function is the integration: Northwind's own backend mints a
 * short-lived token signed with its own key, and Keel verifies it against
 * Northwind's JWKS. Keel never receives a user id it is asked to trust.
 */
async function identity(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/identity-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "keel:northwind" }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    // An anonymous session is second-class but usable; failing to load the
    // widget entirely because the token endpoint blipped is worse.
    return null;
  }
}

const ENDPOINT = import.meta.env["VITE_KEEL_ENDPOINT"] ?? "http://localhost:3001";

export function KeelWidget() {
  return (
    <KeelProvider endpoint={ENDPOINT} projectId="proj_northwind" identity={identity}>
      <ShadowRoot>
        <Assistant />
      </ShadowRoot>
    </KeelProvider>
  );
}
