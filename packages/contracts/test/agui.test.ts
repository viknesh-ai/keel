import { describe, expect, it } from "vitest";
import {
  AGUI_EVENT_TYPES,
  AGUI_MAPPING,
  activity,
  clientVisibleEvents,
  feedsModelContext,
  isClientVisible,
} from "../src/agui.js";
import { EVENT_TYPES, type PlatformEvent } from "../src/events.js";

describe("the mapping is total", () => {
  it("covers every platform event type", () => {
    expect(Object.keys(AGUI_MAPPING).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("only names AG-UI event types we actually emit", () => {
    for (const mapping of Object.values(AGUI_MAPPING)) {
      if (mapping.agui !== null) {
        expect(AGUI_EVENT_TYPES).toContain(mapping.agui);
      }
    }
  });

  it("never emits a REASONING_* event — ADR-018", () => {
    expect(AGUI_EVENT_TYPES.filter((t) => t.startsWith("REASONING"))).toEqual([]);
    for (const mapping of Object.values(AGUI_MAPPING)) {
      expect(mapping.agui ?? "").not.toContain("REASONING");
    }
  });

  it("gives every backend-only event a null AG-UI type, and vice versa", () => {
    for (const [type, mapping] of Object.entries(AGUI_MAPPING)) {
      if (mapping.channel === "backend") {
        expect(mapping.agui, `${type} is backend-only but names an AG-UI event`).toBeNull();
      } else {
        expect(mapping.agui, `${type} is client-visible but maps to nothing`).not.toBeNull();
      }
    }
  });
});

describe("what a browser is allowed to see", () => {
  it("keeps project operations off the client", () => {
    for (const type of [
      "knowledge.sync.started",
      "knowledge.sync.completed",
      "knowledge.sync.failed",
      "budget.exhausted",
      "evaluation.completed",
      "security.signal",
    ] as const) {
      expect(isClientVisible(type), `${type} must not reach a widget`).toBe(false);
    }
  });

  it("does not tell an attacker their injection was detected", () => {
    expect(isClientVisible("security.signal")).toBe(false);
  });

  it("streams the events a widget needs to render a run", () => {
    for (const type of [
      "run.started",
      "run.completed",
      "run.failed",
      "tool.started",
      "tool.completed",
      "approval.requested",
    ] as const) {
      expect(isClientVisible(type)).toBe(true);
    }
  });

  it("maps approval.requested onto INTERRUPT", () => {
    expect(AGUI_MAPPING["approval.requested"].agui).toBe("INTERRUPT");
  });

  it("filters a mixed stream down to the client-safe subset", () => {
    const events = [
      { type: "run.started" },
      { type: "security.signal" },
      { type: "tool.completed" },
      { type: "budget.exhausted" },
    ] as unknown as PlatformEvent[];

    expect(clientVisibleEvents(events).map((e) => e.type)).toEqual([
      "run.started",
      "tool.completed",
    ]);
  });
});

describe("what may re-enter model context", () => {
  it("excludes ACTIVITY-mapped events, so status text cannot become an injection vector", () => {
    for (const [type, mapping] of Object.entries(AGUI_MAPPING)) {
      if (mapping.agui === "ACTIVITY") {
        expect(feedsModelContext(type as keyof typeof AGUI_MAPPING)).toBe(false);
      }
    }
  });

  it("includes tool results, which are what the model observes", () => {
    expect(feedsModelContext("tool.completed")).toBe(true);
    expect(feedsModelContext("tool.failed")).toBe(true);
  });

  it("excludes every backend-only event", () => {
    for (const [type, mapping] of Object.entries(AGUI_MAPPING)) {
      if (mapping.channel === "backend") {
        expect(feedsModelContext(type as keyof typeof AGUI_MAPPING)).toBe(false);
      }
    }
  });
});

describe("activity", () => {
  it("carries a localisation key rather than a literal string", () => {
    const event = activity("run_1", "searching_customers", "started");

    expect(event).toEqual({
      type: "ACTIVITY",
      run_id: "run_1",
      key: "searching_customers",
      state: "started",
    });
  });

  it("includes params when supplied", () => {
    expect(activity("run_1", "found_customers", "done", { count: 43 }).params).toEqual({
      count: 43,
    });
  });
});
