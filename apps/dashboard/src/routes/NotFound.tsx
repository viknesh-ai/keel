import { Button, EmptyState } from "@keel/ui";
import { useNavigate } from "react-router-dom";

export default function NotFoundRoute() {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="No such page"
      description="The address does not match any section of the dashboard."
      action={
        <Button variant="primary" onClick={() => navigate("/agents")}>
          Go to Agents
        </Button>
      }
    />
  );
}
