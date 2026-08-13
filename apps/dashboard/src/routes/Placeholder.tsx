import { EmptyState } from "@keel/ui";

/**
 * These sections have no screens yet. Rather than mock data or a fake table,
 * each says plainly what it will hold and which slice builds it — CLAUDE.md is
 * explicit that a stub presented as working is worse than an honest gap.
 */
export function Placeholder({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <>
      <h1 className="d-title">{title}</h1>
      <EmptyState title="Not built yet" description={body} />
    </>
  );
}
