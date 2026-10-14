import { expect, test } from "vitest";
import { APP_NAME } from "./index";

test("core exports", () => {
  expect(APP_NAME).toBe("plainfeedback");
});
