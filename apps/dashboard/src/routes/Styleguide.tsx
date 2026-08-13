import {
  Badge,
  type BadgeTone,
  Button,
  type ButtonVariant,
  CONTRAST_PAIRS,
  CodeBlock,
  contrastRatio,
  Dialog,
  DropdownMenu,
  Duration,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  Popover,
  Select,
  Skeleton,
  StatusDot,
  type StatusKind,
  Tabs,
  Textarea,
  THEMES,
  Tooltip,
  useToast,
} from "@keel/ui";
import { useState } from "react";
import { useTheme } from "../shell/theme.ts";

/**
 * Every primitive in every state, on one page.
 *
 * This is the reference an engineer opens before building a screen, and it is
 * where a regression in a state nobody routinely exercises (loading, disabled,
 * invalid) becomes visible.
 */

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="d-sg__section">
      <h2 className="d-sg__heading">{title}</h2>
      <div className="d-sg__row">{children}</div>
    </section>
  );
}

const VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const TONES: readonly BadgeTone[] = ["neutral", "info", "success", "warning", "danger"];
const STATUSES: readonly StatusKind[] = ["running", "success", "warning", "failed", "idle"];

export default function StyleguideRoute() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const toast = useToast();
  const { theme } = useTheme();
  const palette = THEMES[theme];

  return (
    <>
      <h1 className="d-title">Styleguide</h1>
      <p className="d-sg__lede">
        Every primitive in every state. Use the theme toggle in the header to check both.
      </p>

      <Section title="Button">
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button variant="primary" size="sm">
          small
        </Button>
        <Button variant="primary" loading>
          loading
        </Button>
        <Button variant="primary" disabled>
          disabled
        </Button>
      </Section>

      <Section title="IconButton">
        <IconButton label="Refresh">↻</IconButton>
        <IconButton label="Refresh, small" size="sm">
          ↻
        </IconButton>
        <IconButton label="Delete" variant="danger">
          ×
        </IconButton>
        <IconButton label="Disabled" disabled>
          ↻
        </IconButton>
      </Section>

      <Section title="Input">
        <Input aria-label="Default" placeholder="Search runs…" />
        <Input aria-label="Mono" mono defaultValue="run_01JXQ4Z8K3" />
        <Input aria-label="Small" size="sm" placeholder="Compact" />
        <Input aria-label="Invalid" invalid defaultValue="not-an-email" />
        <Input aria-label="Disabled" disabled defaultValue="Read only" />
      </Section>

      <Section title="Textarea">
        <Textarea aria-label="Instructions" placeholder="Agent instructions…" />
        <Textarea aria-label="Invalid textarea" invalid defaultValue="{ broken json" mono />
      </Section>

      <Section title="Badge">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
        <Badge tone="danger" mono>
          PolicyViolationError
        </Badge>
      </Section>

      <Section title="StatusDot">
        {STATUSES.map((status) => (
          <StatusDot key={status} status={status} showLabel />
        ))}
      </Section>

      <Section title="Duration">
        <Duration ms={0.4} />
        <Duration ms={87} />
        <Duration ms={1500} />
        <Duration ms={12_400} />
        <Duration ms={65_000} />
      </Section>

      <Section title="Skeleton">
        <div style={{ display: "grid", gap: "8px", width: "320px" }}>
          <Skeleton width="60%" />
          <Skeleton />
          <Skeleton width="80%" />
          <Skeleton height="32px" radius="md" />
        </div>
      </Section>

      <Section title="Overlays">
        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Upgrade Arun to Pro"
          description="This changes billing immediately and cannot be undone from here."
          footer={
            <>
              <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Upgrade
              </Button>
            </>
          }
        >
          <KeyValue
            items={[
              { key: "customer", value: "cus_01JXQ4Z8K3" },
              { key: "from", value: "Starter" },
              { key: "to", value: "Pro" },
            ]}
          />
        </Dialog>

        <Popover trigger={<Button>Popover</Button>}>
          <p style={{ margin: 0 }}>
            Borders, not shadows — except here, where it genuinely floats.
          </p>
        </Popover>

        <DropdownMenu
          trigger={<Button>Menu</Button>}
          items={[
            {
              id: "rerun",
              label: "Re-run",
              onSelect: () => toast.push({ title: "Re-run queued" }),
            },
            { id: "export", label: "Export trace", onSelect: () => undefined },
            { id: "disabled", label: "Unavailable", onSelect: () => undefined, disabled: true },
            {
              id: "cancel",
              label: "Cancel run",
              destructive: true,
              onSelect: () => toast.push({ title: "Run cancelled", tone: "danger" }),
            },
          ]}
        />

        <Tooltip content="Total cost of this run">
          <Button>Hover or focus me</Button>
        </Tooltip>

        <Select
          label="Environment"
          placeholder="Environment"
          value={selected}
          onValueChange={setSelected}
          options={[
            { value: "development", label: "development" },
            { value: "staging", label: "staging" },
            { value: "production", label: "production" },
          ]}
        />

        <Button onClick={() => toast.push({ title: "Saved", tone: "success" })}>Toast</Button>
      </Section>

      <Section title="Tabs">
        <div style={{ width: "100%" }}>
          <Tabs
            label="Styleguide example"
            items={[
              { id: "steps", label: "Steps", content: <p>The step timeline lands here.</p> },
              { id: "policy", label: "Policy", content: <p>Decision and matched rule id.</p> },
              { id: "raw", label: "Raw", content: <CodeBlock code={'{\n  "ok": true\n}'} /> },
            ]}
          />
        </div>
      </Section>

      <Section title="KeyValue">
        <div style={{ width: "100%", maxWidth: "560px" }}>
          <KeyValue
            items={[
              { key: "run_id", value: "run_01JXQ4Z8K3M2P9" },
              { key: "agent_version", value: "av_01JXQ4Z8K3" },
              { key: "model", value: "claude-sonnet" },
              { key: "trigger", value: "chat", mono: false },
            ]}
          />
        </div>
      </Section>

      <Section title="CodeBlock">
        <div style={{ width: "100%", maxWidth: "560px" }}>
          <CodeBlock
            label="tool_call.json"
            language="json"
            code={'{\n  "tool": "get_customer",\n  "args": { "customer_id": "cus_01JXQ4Z8K3" }\n}'}
          />
        </div>
      </Section>

      <Section title="EmptyState">
        <div style={{ width: "100%", maxWidth: "560px" }}>
          <EmptyState
            title="No runs yet"
            description="Runs appear here once an agent handles its first message."
            action={<Button variant="primary">Create an agent</Button>}
          />
        </div>
      </Section>

      <section className="d-sg__section">
        <h2 className="d-sg__heading">Token matrix — {theme}</h2>
        <p className="d-sg__lede">
          Every pair CI verifies, with its measured ratio. These are the same values
          <code className="k-mono"> packages/ui/test/contrast.test.ts </code> asserts on.
        </p>
        <table className="d-sg__table">
          <thead>
            <tr>
              <th>Foreground</th>
              <th>Background</th>
              <th>Ratio</th>
              <th>Required</th>
              <th>Sample</th>
            </tr>
          </thead>
          <tbody>
            {CONTRAST_PAIRS.map((pair) => {
              const fg = palette[pair.fg];
              const bg = palette[pair.bg];
              return (
                <tr key={`${pair.fg}-${pair.bg}-${pair.usage}`}>
                  <td className="k-mono">{pair.fg}</td>
                  <td className="k-mono">{pair.bg}</td>
                  <td className="k-mono">{contrastRatio(fg, bg).toFixed(2)}:1</td>
                  <td className="k-mono">{pair.level === "AA" ? "4.5" : "3.0"}</td>
                  <td>
                    <span
                      className="d-sg__swatch"
                      style={{ color: fg, background: bg, borderColor: palette["border-default"] }}
                    >
                      {pair.usage}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
