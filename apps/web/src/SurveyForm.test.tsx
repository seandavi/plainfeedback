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
    expect(screen.getAllByText("1 = Poor")).toHaveLength(3); // key, then under each row (#66)
    expect(screen.getByText("3 = Okay")).toBeTruthy();
    // Short radio names; the anchors are the row's description, read once per row.
    expect(within(group("Venue")).getByRole("radio", { name: "5" })).toBeTruthy();
    const ends = document.getElementById(group("Venue").getAttribute("aria-describedby") ?? "");
    expect(ends?.textContent?.trim()).toBe("1 = Poor 5 = Great");
    expect(ends?.getAttribute("aria-hidden")).toBe("true");
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
    expect(
      within(group("Rate")).getByText("Please rate every statement (2 not rated: Content; Venue)."),
    ).toBeTruthy();
    const first = within(group("role")).getAllByRole("radio")[0] as HTMLElement;
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(first);
    expect(screen.getByRole("alert").textContent).toContain("2 answers");
  });

  it("names unrated grid rows next to the legend and marks each row (#56)", async () => {
    setup();
    fireEvent.click(within(group("role")).getByRole("radio", { name: "Staff" }));
    fireEvent.click(within(group("Content")).getByRole("radio", { name: "3" }));
    submit();
    await flush();
    const err = within(group("Rate")).getByText(
      "Please rate every statement (1 not rated: Venue).",
    );
    const firstRow = group("Content");
    expect(err.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group("Venue").className).toContain("unrated");
    expect(group("Venue").querySelector("legend")?.textContent).toContain("(not rated)");
    expect(firstRow.className).not.toContain("unrated");
    const radio = within(group("Venue")).getAllByRole("radio")[0] as HTMLElement;
    expect(radio.getAttribute("aria-invalid")).toBe("true");
    expect(radio.getAttribute("aria-describedby")).toBe(err.id);
    expect(document.activeElement).toBe(radio);
  });

  it("Other picked but blank: says so and focuses the text box (#67)", async () => {
    const onSubmit = setup();
    fillRequired();
    fireEvent.click(within(group("role")).getByRole("radio", { name: "Other" }));
    fireEvent.click(within(group("Topics")).getByRole("checkbox", { name: "Something else" }));
    submit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(group("role")).getByText('Please describe "Other", or pick another option.'));
    expect(
      within(group("Topics")).getByText(
        'Please describe "Something else", or pick another option.',
      ),
    ).toBeTruthy();
    const box = screen.getByLabelText("Other: please specify");
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    for (const r of within(group("role")).getAllByRole("radio"))
      expect(r.getAttribute("aria-invalid")).toBeNull();
  });

  it("announces when a text box reaches its limit (#77)", () => {
    setup();
    const notes = screen.getByLabelText("Notes");
    const live = notes.parentElement?.querySelector("[aria-live]");
    expect(live?.textContent).toBe(""); // mounted empty, so the change is announced
    fireEvent.change(notes, { target: { value: "x".repeat(10) } });
    expect(live?.textContent).toBe("Limit reached: only the first 10 characters are kept.");
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
    expect(onSubmit).toHaveBeenCalledWith(
      {
        role: "Visitor",
        topics: ["Tools", "Ethics"],
        ratings: { "1": 3, "2": 5 },
        notes: "ok",
        years: 4.5,
      },
      "",
    );
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

  it("shows option labels and submits their stored values (#122)", async () => {
    const valued = compile(`# T

::: {.choice #sat required}
How satisfied?
- Very satisfied {value=5}
- Not at all {value=1}
:::

::: {.multi #m}
Which?
- Alpha {value=a}
- Beta {value=b}
:::
`).model as Survey;
    const onSubmit = vi.fn(async () => undefined);
    render(<SurveyForm model={valued} mode="live" onSubmit={onSubmit} />);
    const radio = within(group("satisfied")).getByRole("radio", { name: "Very satisfied" });
    expect(radio.getAttribute("value")).toBe("5");
    fireEvent.click(radio);
    fireEvent.click(within(group("Which")).getByRole("checkbox", { name: "Beta" }));
    submit();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ sat: "5", m: ["b"] }, "");
  });

  describe("dropdown (#123)", () => {
    const dd = (flags: string) => {
      const m = compile(`# T

::: {.choice #inst dropdown ${flags}}
Your institution?
- Uni A {value=ua}
- Uni B
:::
`).model as Survey;
      const onSubmit = vi.fn(async () => undefined);
      render(<SurveyForm model={m} mode="live" onSubmit={onSubmit} />);
      return { onSubmit, select: screen.getByRole("combobox", { name: /Your institution/ }) };
    };

    it("renders a labelled select with a placeholder and value/label options", () => {
      const { select } = dd("");
      const opts = within(select).getAllByRole("option") as HTMLOptionElement[];
      expect(opts.map((o) => [o.value, o.textContent])).toEqual([
        ["", "Choose one"],
        ["ua", "Uni A"],
        ["Uni B", "Uni B"],
      ]);
    });

    it("the placeholder clears an optional answer", async () => {
      const { onSubmit, select } = dd("");
      fireEvent.change(select, { target: { value: "ua" } });
      fireEvent.change(select, { target: { value: "" } });
      submit();
      await flush();
      expect(onSubmit).toHaveBeenCalledWith({}, "");
    });

    it("submits the stored value", async () => {
      const { onSubmit, select } = dd("required");
      fireEvent.change(select, { target: { value: "ua" } });
      submit();
      await flush();
      expect(onSubmit).toHaveBeenCalledWith({ inst: "ua" }, "");
    });

    it("required and empty: marks and focuses the select", async () => {
      const { onSubmit, select } = dd("required");
      submit();
      await flush();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(select.getAttribute("aria-invalid")).toBe("true");
      expect(select.getAttribute("aria-describedby")).toBeTruthy();
      expect(document.activeElement).toBe(select);
    });

    it("Other shows the text box; blank is an error on it, text is the answer", async () => {
      const { onSubmit, select } = dd("other");
      expect(screen.queryByLabelText("Other: please specify")).toBeNull();
      const other = within(select).getByRole("option", { name: "Other" }) as HTMLOptionElement;
      fireEvent.change(select, { target: { value: other.value } });
      const box = screen.getByLabelText("Other: please specify");
      submit();
      await flush();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText('Please describe "Other", or pick another option.')).toBeTruthy();
      expect(document.activeElement).toBe(box);
      expect(select.getAttribute("aria-invalid")).toBeNull();
      fireEvent.change(box, { target: { value: "Visitor" } });
      submit();
      await flush();
      expect(onSubmit).toHaveBeenCalledWith({ inst: "Visitor" }, "");
    });
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
