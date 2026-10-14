// @vitest-environment jsdom
import { compile, type Survey } from "@plainfeedback/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";
import { SurveyForm } from "./SurveyForm";

afterEach(cleanup);

const MD = `# T

::: {.choice #role required other}
Your **role**?
- Staff
- Student
:::

::: {.multi #topics other="Something else"}
Topics?
- Data
- Tools
:::

::: {.likert #ratings required scale="1-5" low="Poor" mid="Okay" high="Great"}
Rate:
- Content
- Venue
:::

::: {.text #notes maxlength=10}
Notes
:::

::: {.text #long multiline}
Longer notes
:::

::: {.number #years min=0 max=50}
Years
:::
`;
const model = compile(MD).model as Survey;

const setup = (mode: "live" | "preview" = "live", result?: Record<string, string>) => {
  const onSubmit = vi.fn(async () => result);
  render(<SurveyForm model={model} mode={mode} onSubmit={onSubmit} />);
  return onSubmit;
};
const group = (name: string) => screen.getByRole("group", { name: new RegExp(name) });
const submit = () => fireEvent.click(screen.getByRole("button", { name: /submit|check/i }));
const flush = () => new Promise((r) => setTimeout(r, 0));
const fillRequired = () => {
  fireEvent.click(within(group("role")).getByRole("radio", { name: "Staff" }));
  fireEvent.click(within(group("Content")).getByRole("radio", { name: /^3/ }));
  fireEvent.click(within(group("Venue")).getByRole("radio", { name: /^5/ }));
};

describe("SurveyForm", () => {
  it("renders every question type with labels and visible anchors", () => {
    setup();
    expect(within(group("role")).getAllByRole("radio")).toHaveLength(3);
    expect(group("role").querySelector("strong")?.textContent).toBe("role");
    expect(within(group("Topics")).getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("1 = Poor")).toBeTruthy();
    expect(screen.getByText("3 = Okay")).toBeTruthy();
    expect(within(group("Venue")).getByRole("radio", { name: /^5\s*Great$/ })).toBeTruthy();
    expect(screen.getByLabelText("Notes").getAttribute("maxlength")).toBe("10");
    expect(screen.getByLabelText("Longer notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Years").getAttribute("type")).toBe("number");
  });

  it("blocks submit with per-question errors and focuses the first", async () => {
    const onSubmit = setup();
    submit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(group("role")).getByText("This question is required.")).toBeTruthy();
    expect(within(group("Rate")).getByText("This question is required.")).toBeTruthy();
    const first = within(group("role")).getAllByRole("radio")[0] as HTMLElement;
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(first);
    expect(screen.getByRole("alert").textContent).toContain("2 answers");
  });

  it("submits typed answers including Other text, multi and number", async () => {
    const onSubmit = setup();
    fillRequired();
    fireEvent.click(within(group("role")).getByRole("radio", { name: "Other" }));
    fireEvent.change(screen.getByLabelText("Other: please specify"), {
      target: { value: "Visitor" },
    });
    fireEvent.click(within(group("Topics")).getByRole("checkbox", { name: "Tools" }));
    fireEvent.click(within(group("Topics")).getByRole("checkbox", { name: "Something else" }));
    fireEvent.change(screen.getByLabelText("Something else: please specify"), {
      target: { value: "Ethics" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText("Years"), { target: { value: "4.5" } });
    expect(screen.getByText("2 / 10 characters")).toBeTruthy();
    submit();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({
      role: "Visitor",
      topics: ["Tools", "Ethics"],
      ratings: { "1": 3, "2": 5 },
      notes: "ok",
      years: 4.5,
    });
  });

  it("validates number range on the client", async () => {
    const onSubmit = setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Years"), { target: { value: "99" } });
    submit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number of at most 50.")).toBeTruthy();
  });

  it("shows server errors on their questions", async () => {
    setup("live", { notes: "Server says no." });
    fillRequired();
    submit();
    await flush();
    await flush();
    expect(screen.getByText("Server says no.")).toBeTruthy();
    expect(screen.getByLabelText("Notes").getAttribute("aria-invalid")).toBe("true");
  });

  it("preview mode validates but never submits", async () => {
    const onSubmit = setup("preview");
    fillRequired();
    submit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Preview");
  });
});

describe("Markdown", () => {
  it("renders basic markdown without raw HTML, unsafe links or images", () => {
    const { container } = render(
      <Markdown
        text={
          "Hi <script>alert(1)</script> **b** _i_ `c` snake_case_name\n\n- [ok](https://x.org) [bad](javascript:alert(1)) ![pic](https://cdn.example/x.png)"
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("strong")?.textContent).toBe("b");
    expect(container.querySelector("em")?.textContent).toBe("i");
    expect(container.querySelector("code")?.textContent).toBe("c");
    expect(container.textContent).toContain("snake_case_name");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://x.org");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("li")?.textContent).toContain("bad");
  });
});
