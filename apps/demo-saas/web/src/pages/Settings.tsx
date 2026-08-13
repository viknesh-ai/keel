import { Badge, Button, CodeBlock, KeyValue } from "@keel/ui";
import type { Staff } from "../api.ts";

export default function SettingsPage({ staff, onLogout }: { staff: Staff; onLogout: () => void }) {
  return (
    <>
      <h1 className="nw-title">Settings</h1>

      <h2 className="nw-heading">Signed in as</h2>
      <KeyValue
        items={[
          { key: "Name", value: staff.name, mono: false },
          { key: "Email", value: staff.email },
          { key: "Role", value: <Badge>{staff.role}</Badge>, mono: false },
          { key: "Staff ID", value: staff.id },
        ]}
      />
      <div className="nw-actions">
        <Button variant="danger" onClick={onLogout}>
          Sign out
        </Button>
      </div>

      <h2 className="nw-heading">API</h2>
      <p className="nw-sub">
        The OpenAPI 3.1 specification is served from the API and is the contract Keel imports to
        derive tool definitions.
      </p>
      <CodeBlock
        label="fetch the spec"
        code={
          "curl http://localhost:4000/openapi.yaml\ncurl http://localhost:4000/.well-known/jwks.json"
        }
      />
    </>
  );
}
