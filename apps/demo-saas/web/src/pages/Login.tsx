import { Button, Input } from "@keel/ui";
import { type FormEvent, useState } from "react";
import { api, type Staff } from "../api.ts";

export default function LoginPage({ onSignedIn }: { onSignedIn: (staff: Staff) => void }) {
  const [email, setEmail] = useState("ops@northwind.example");
  const [password, setPassword] = useState("northwind");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(email, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nw-login">
      <form className="nw-login__card" onSubmit={submit}>
        <h1 className="nw-login__title">Northwind Cloud</h1>
        <p className="nw-sub">
          Demo credentials are pre-filled. Other roles: support@, finance@, viewer@ — same password.
        </p>

        {/* Explicit htmlFor/id rather than wrapping: the association survives the
            component boundary, which implicit nesting through <Input> does not
            make obvious to either a reader or a linter. */}
        <div className="nw-field">
          <label htmlFor="login-email">Email</label>
          <Input
            id="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </div>

        <div className="nw-field">
          <label htmlFor="login-password">Password</label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        {error === null ? null : (
          <p className="nw-error" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
