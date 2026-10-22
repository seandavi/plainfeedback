// @vitest-environment jsdom
// usePageTitle: a page being left must not steal the next page's focus (#131).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { navigate, usePageTitle } from "./router";

function Page({ title }: { title: string | undefined }) {
  usePageTitle(title);
  return (
    <main>
      <h1>{title}</h1>
    </main>
  );
}

afterEach(cleanup);

it("a page whose title arrives after navigate() leaves focus for the next page", () => {
  history.pushState(null, "", "/a");
  const { rerender } = render(<Page key="/a" title={undefined} />);
  act(() => {
    navigate("/b");
  });
  // The stale /a page's title effect fires late: it must do nothing.
  rerender(<Page key="/a" title="A" />);
  expect(document.activeElement).toBe(document.body);
  expect(document.title).not.toBe("A – plainfeedback");
  rerender(<Page key="/b" title="B" />);
  expect(document.activeElement).toBe(document.querySelector("main h1"));
  expect(document.title).toBe("B – plainfeedback");
});
