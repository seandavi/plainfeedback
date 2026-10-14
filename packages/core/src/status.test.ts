import { describe, expect, it } from "vitest";
import { surveyStatus } from "./status";

const now = new Date("2026-10-10T00:00:00Z");
const p = { published: true };
describe("surveyStatus", () => {
  it("draft when unpublished", () => expect(surveyStatus({ published: false }, now)).toBe("draft"));
  it("no window = open", () => expect(surveyStatus(p, now)).toBe("open"));
  it("not yet open", () =>
    expect(surveyStatus({ ...p, opensAt: "2026-11-01T00:00:00Z" }, now)).toBe("not_yet_open"));
  it("open inside the window", () =>
    expect(
      surveyStatus(
        { ...p, opensAt: new Date("2026-10-01"), closesAt: "2026-12-01T00:00:00Z" },
        now,
      ),
    ).toBe("open"));
  it("closed by end time (inclusive) or manual close", () => {
    expect(surveyStatus({ ...p, closesAt: now }, now)).toBe("closed");
    expect(surveyStatus({ ...p, closedAt: "2026-10-01T00:00:00Z" }, now)).toBe("closed");
  });
  it("closed wins over not yet open", () =>
    expect(surveyStatus({ ...p, closedAt: now, opensAt: "2027-01-01T00:00:00Z" }, now)).toBe(
      "closed",
    ));
});
