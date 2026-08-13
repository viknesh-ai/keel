import { Skeleton } from "@keel/ui";

/** Shown while a route chunk loads. Structure, not a spinner. */
export function RouteFallback() {
  return (
    <div className="d-fallback" aria-busy="true" aria-live="polite">
      <span className="k-sr-only">Loading section</span>
      <Skeleton width="180px" height="24px" radius="md" />
      <Skeleton width="100%" height="120px" radius="md" />
      <Skeleton width="70%" height="120px" radius="md" />
    </div>
  );
}
