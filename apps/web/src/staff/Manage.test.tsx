// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SurveySummary } from "./api";
import { surveyStatus } from "./Dashboard";
import { StaffApp } from "./StaffApp";

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const G = "11111111-1111-1111-1111-111111111111";
const group = (role: string | null, over = {}) => ({
  id: G,
  name: "Lab",
  archived: false,
  role,
  ...over,
});
const user = (id: string, email: string, isAdmin = false) => ({
  id,
  email,
  isAdmin,
  createdAt: "2026-10-01T00:00:00Z",
});
const base = (admin: boolean) => ({
  "GET /api/v1/me": (): [number, unknown] => [200, { id: "me", email: "me@x.org", isAdmin: admin }],
});

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = {
        method: init.method ?? "GET",
        path: url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(c);
      const h = routes[`${c.method} ${url}`];
      return h ? json(...h(c)) : json(404, { error: "not found" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) => {
  history.pushState(null, "", path);
  return render(<StaffApp />);
};
const called = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("dashboard", () => {
  it("lists my groups with role, survey status and response counts", async () => {
    routes = {
      ...base(false),
      "GET /api/v1/groups": () => [200, [group("creator")]],
      [`GET /api/v1/groups/${G}/events`]: () => [
        200,
        [{ id: "ev1", slug: "fall", title: "Fall", description: "" }],
      ],
      "GET /api/v1/events/ev1/surveys": () => [
        200,
        [
          { slug: "pre", closed: false, latestVersion: null, responseCount: 0 },
          { slug: "post", closed: false, latestVersion: 2, responseCount: 17 },
        ],
      ],
    };
    open("/app");
    const table = await screen.findByRole("table", { name: "Surveys in Lab" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("draft")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("open")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("17")).toBeTruthy();
    expect(screen.getByText("creator")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("derives status from closed and the open window", () => {
    const s = (o: Partial<SurveySummary>) =>
      ({ latestVersion: 1, closed: false, ...o }) as SurveySummary;
    const now = new Date("2026-10-10T00:00:00Z");
    expect(surveyStatus(s({ opensAt: "2026-11-01T00:00:00Z" }), now)).toBe("not yet open");
    expect(surveyStatus(s({ opensAt: "2026-10-01T00:00:00Z" }), now)).toBe("open");
    expect(surveyStatus(s({ closesAt: "2026-10-05T00:00:00Z" }), now)).toBe("closed");
    expect(surveyStatus(s({ closed: true }), now)).toBe("closed");
    expect(surveyStatus(s({}), now)).toBe("open");
  });
});

describe("admin", () => {
  const adminRoutes = () => {
    routes = {
      ...base(true),
      "GET /api/v1/users": () => [200, [user("me", "me@x.org", true), user("u2", "bob@x.org")]],
      "GET /api/v1/groups": () => [
        200,
        [group(null), group(null, { id: "g2", name: "Old", archived: true })],
      ],
    };
  };

  it("is hidden from non-admins; the page also refuses them", async () => {
    routes = base(false);
    open("/app/admin");
    expect(await screen.findByText(/Only admins/)).toBeTruthy();
    expect(called("GET", "/api/v1/users")).toHaveLength(0);
  });

  it("grants admin, and explains a last-admin 409", async () => {
    adminRoutes();
    routes["PATCH /api/v1/users/u2"] = () => [200, user("u2", "bob@x.org", true)];
    routes["PATCH /api/v1/users/me"] = () => [409, { error: "at least one admin is required" }];
    open("/app/admin");
    expect(await screen.findByRole("table", { name: "Users who have signed in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Admin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grant admin bob@x.org" }));
    // #78: granting admin asks first, like revoking.
    expect(called("PATCH", "/api/v1/users/u2")).toHaveLength(0);
    const grant = await screen.findByRole("dialog", { name: "Grant admin" });
    fireEvent.click(within(grant).getByRole("button", { name: "Grant admin" }));
    await waitFor(() =>
      expect(called("PATCH", "/api/v1/users/u2")[0]?.body).toEqual({ isAdmin: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke admin me@x.org" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke admin" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke admin" }));
    expect(await screen.findByText(/at least one admin is required/)).toBeTruthy();
  });

  it("disables after confirmation and enables a disabled user (#38)", async () => {
    adminRoutes();
    let disabled = false;
    routes["GET /api/v1/users"] = () => [
      200,
      [user("me", "me@x.org", true), { ...user("u2", "bob@x.org"), disabled }],
    ];
    routes["PATCH /api/v1/users/u2"] = (c) => {
      disabled = (c.body as { disabled: boolean }).disabled;
      return [200, { ...user("u2", "bob@x.org"), disabled }];
    };
    open("/app/admin");
    await screen.findByRole("table", { name: "Users who have signed in" });
    fireEvent.click(screen.getByRole("button", { name: "Disable bob@x.org" }));
    const dialog = await screen.findByRole("dialog", { name: "Disable user" });
    expect(dialog.textContent).toMatch(/signed out everywhere/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(called("PATCH", "/api/v1/users/u2")[0]?.body).toEqual({ disabled: true }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Enable bob@x.org" }));
    await waitFor(() =>
      expect(called("PATCH", "/api/v1/users/u2")[1]?.body).toEqual({ disabled: false }),
    );
  });

  it("creates, renames, archives and unarchives groups", async () => {
    adminRoutes();
    routes["POST /api/v1/groups"] = () => [201, group(null, { name: "New" })];
    routes[`PATCH /api/v1/groups/${G}`] = () => [200, group(null)];
    routes["PATCH /api/v1/groups/g2"] = () => [200, group(null)];
    open("/app/admin");
    await screen.findByRole("table", { name: /All groups/ });
    expect(screen.getByText("Archived")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " New " } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(called("POST", "/api/v1/groups")[0]?.body).toEqual({ name: "New" }));

    fireEvent.click(screen.getByRole("button", { name: "Rename Lab" }));
    fireEvent.change(screen.getByLabelText("New name for Lab"), { target: { value: "Lab 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(called("PATCH", `/api/v1/groups/${G}`)[0]?.body).toEqual({ name: "Lab 2" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive Lab" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive group" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(called("PATCH", `/api/v1/groups/${G}`)).toHaveLength(2));
    expect(called("PATCH", `/api/v1/groups/${G}`)[1]?.body).toEqual({ archived: true });

    fireEvent.click(screen.getByRole("button", { name: "Unarchive Old" }));
    await waitFor(() =>
      expect(called("PATCH", "/api/v1/groups/g2")[0]?.body).toEqual({ archived: false }),
    );
  });

  it("assigns an owner by email and explains an unknown user", async () => {
    adminRoutes();
    routes[`PUT /api/v1/groups/${G}/members/new%40x.org`] = () => [404, { error: "not found" }];
    routes[`PUT /api/v1/groups/${G}/members/bob%40x.org`] = () => [
      200,
      { userId: "u2", email: "bob@x.org", role: "owner" },
    ];
    open("/app/admin");
    await screen.findByRole("table", { name: /All groups/ });
    const email = screen.getByLabelText(/Owner email/);
    fireEvent.change(email, { target: { value: "new@x.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    expect(await screen.findByText(/Ask them to sign in once first/)).toBeTruthy();
    fireEvent.change(email, { target: { value: "bob@x.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    await waitFor(() =>
      expect(called("PUT", `/api/v1/groups/${G}/members/bob%40x.org`)[0]?.body).toEqual({
        role: "owner",
      }),
    );
  });

  it("shows the server's refusal when the API says forbidden", async () => {
    adminRoutes();
    routes["PATCH /api/v1/users/u2"] = () => [403, { error: "admin only" }];
    open("/app/admin");
    await screen.findByRole("table", { name: /Users/ });
    fireEvent.click(screen.getByRole("button", { name: "Grant admin bob@x.org" }));
    const grant = await screen.findByRole("dialog", { name: "Grant admin" });
    fireEvent.click(within(grant).getByRole("button", { name: "Grant admin" }));
    expect(await screen.findByText(/Your role does not allow this/)).toBeTruthy();
  });
});

describe("group page", () => {
  const M = `/api/v1/groups/${G}/members`;
  const groupRoutes = (role: string) => {
    routes = {
      ...base(false),
      [`GET /api/v1/groups/${G}`]: () => [200, group(role)],
      [`GET /api/v1/groups/${G}/events`]: () => [200, []],
      [`GET ${M}`]: () => [
        200,
        [
          { userId: "o1", email: "owner@x.org", role: "owner" },
          { userId: "v1", email: "view@x.org", role: "viewer" },
        ],
      ],
      [`GET /api/v1/groups/${G}/tokens`]: () => [200, []],
    };
  };

  it("lets an owner change roles and explains a last-owner 409", async () => {
    groupRoutes("owner");
    routes[`PUT ${M}/v1`] = () => [200, { userId: "v1", email: "view@x.org", role: "creator" }];
    routes[`PUT ${M}/o1`] = () => [409, { error: "a group needs at least one owner" }];
    open(`/app/g/${G}`);
    const table = await screen.findByRole("table", { name: "Members of Lab" });
    const region = screen.getByRole("region", { name: "Members of Lab" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.contains(table)).toBe(true);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Email", "Role", "Actions"]);
    fireEvent.change(screen.getByLabelText("Role of view@x.org"), { target: { value: "creator" } });
    await waitFor(() => expect(called("PUT", `${M}/v1`)[0]?.body).toEqual({ role: "creator" }));
    expect((await screen.findByRole("status")).textContent).toBe("view@x.org is now creator."); // #78
    fireEvent.change(screen.getByLabelText("Role of owner@x.org"), { target: { value: "viewer" } });
    expect(await screen.findByText(/at least one owner/)).toBeTruthy();
    expect((screen.getByLabelText("Role of owner@x.org") as HTMLSelectElement).value).toBe("owner");
  });

  it("asks before removing a member and handles the last-owner 409", async () => {
    groupRoutes("owner");
    routes[`DELETE ${M}/v1`] = () => [204, undefined];
    routes[`DELETE ${M}/o1`] = () => [409, { error: "a group needs at least one owner" }];
    open(`/app/g/${G}`);
    await screen.findByRole("table", { name: "Members of Lab" });
    const opener = screen.getByRole("button", { name: "Remove view@x.org" });
    fireEvent.click(opener);
    let dialog = await screen.findByRole("dialog", { name: "Remove member" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(called("DELETE", `${M}/v1`)).toHaveLength(0);
    fireEvent.click(opener);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(called("DELETE", `${M}/v1`)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove owner@x.org" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    expect(await screen.findByText(/at least one owner/)).toBeTruthy();
  });

  it("adds a member by email and explains an unknown email", async () => {
    groupRoutes("owner");
    routes[`PUT ${M}/ann%40x.org`] = () => [
      200,
      { userId: "a", email: "ann@x.org", role: "creator" },
    ];
    routes[`PUT ${M}/nobody%40x.org`] = () => [404, { error: "not found" }];
    open(`/app/g/${G}`);
    await screen.findByRole("table", { name: "Members of Lab" });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "nobody@x.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByText(/Ask them to sign in once first/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ann@x.org" } });
    const add = screen.getByRole("group", { name: "Add a member" });
    fireEvent.change(within(add).getByLabelText("Role"), { target: { value: "creator" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() =>
      expect(called("PUT", `${M}/ann%40x.org`)[0]?.body).toEqual({ role: "creator" }),
    );
  });

  it("gives viewers a read-only member list and no member controls", async () => {
    groupRoutes("viewer");
    open(`/app/g/${G}`);
    await screen.findByRole("table", { name: "Members of Lab" });
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    // A viewer can only create a viewer token.
    expect(
      within(screen.getByLabelText("Role", { selector: "select" })).getAllByRole("option"),
    ).toHaveLength(1);
  });

  const TOKEN = {
    id: "t1",
    userId: "o1",
    email: "owner@x.org",
    name: "ci",
    role: "creator",
    expiresAt: "2027-01-01T00:00:00Z",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
  };

  it("shows a new token's plaintext exactly once, with a warning and copy", async () => {
    groupRoutes("creator");
    routes[`POST /api/v1/groups/${G}/tokens`] = () => [201, { ...TOKEN, token: "pf_secret123" }];
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open(`/app/g/${G}`);
    await screen.findByRole("heading", { name: "Advanced: API tokens" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.change(screen.getByLabelText(/Expires after/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    const box = (await screen.findByLabelText("New API token")) as HTMLInputElement;
    expect(box.value).toBe("pf_secret123");
    expect(called("POST", `/api/v1/groups/${G}/tokens`)[0]?.body).toEqual({
      name: "ci",
      role: "creator",
      expiresInDays: 30,
    });
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pf_secret123"));
    fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByLabelText("New API token")).toBeNull();
    expect(document.body.textContent).not.toContain("pf_secret123");
  });

  it("lists tokens and revokes one after confirmation; no owner role is offered", async () => {
    groupRoutes("owner");
    routes[`GET /api/v1/groups/${G}/tokens`] = () => [
      200,
      [TOKEN, { ...TOKEN, id: "t2", name: "old", revokedAt: "2026-10-02T00:00:00Z" }],
    ];
    routes[`DELETE /api/v1/groups/${G}/tokens/t1`] = () => [204, undefined];
    open(`/app/g/${G}`);
    const table = await screen.findByRole("table", { name: "API tokens of Lab" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "User", "Role", "Created", "Expires", "Last used", "Actions"]);
    expect(within(table).getByText("Revoked")).toBeTruthy();
    const form = within(screen.getByRole("group", { name: "New API token" }));
    const roles = within(form.getByLabelText("Role")).getAllByRole("option");
    expect(roles.map((o) => o.textContent)).toEqual(["creator", "viewer"]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke ci" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke" }),
    );
    await waitFor(() => expect(called("DELETE", `/api/v1/groups/${G}/tokens/t1`)).toHaveLength(1));
  });
});

describe("deletion (#36)", () => {
  const ev = { id: "ev1", slug: "fall", title: "Fall", description: "" };
  const eventRoutes = (role: string) => {
    routes = {
      ...base(false),
      [`GET /api/v1/groups/${G}`]: () => [200, group(role)],
      [`GET /api/v1/groups/${G}/events`]: () => [200, [ev]],
      [`GET /api/v1/groups/${G}/events/fall`]: () => [200, ev],
      "GET /api/v1/events/ev1/surveys": () => [
        200,
        [
          { slug: "pre", closed: false, latestVersion: null, responseCount: 0 },
          { slug: "post", closed: false, latestVersion: 2, responseCount: 17 },
        ],
      ],
      "DELETE /api/v1/events/ev1/surveys/pre": () => [204, undefined],
      [`DELETE /api/v1/groups/${G}/events/fall`]: () => [204, undefined],
      "DELETE /api/v1/events/ev1/surveys/post/responses?before=2026-01-01T00%3A00%3A00.000Z":
        () => [200, { deleted: 3 }],
    };
  };
  const confirm = async (button: string, title: string, action = "Delete") => {
    fireEvent.click(await screen.findByRole("button", { name: button }));
    const dialog = await screen.findByRole("dialog", { name: title });
    fireEvent.click(within(dialog).getByRole("button", { name: action }));
  };

  it("a creator may delete only unpublished surveys, and sees no response or event deletion", async () => {
    eventRoutes("creator");
    open(`/app/g/${G}/e/fall`);
    await confirm("Delete pre", "Delete survey");
    await waitFor(() => expect(called("DELETE", "/api/v1/events/ev1/surveys/pre")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Delete post" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Delete responses" })).toBeNull();
  });

  it("an owner deletes responses before a date after confirming", async () => {
    eventRoutes("owner");
    open(`/app/g/${G}/e/fall`);
    expect(await screen.findByRole("button", { name: "Delete post" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Submitted before/), {
      target: { value: "2026-01-01" },
    });
    await confirm("Delete responses", "Delete responses");
    expect(await screen.findByText("Deleted 3 responses.")).toBeTruthy();
  });

  it("an owner deletes an event from the group page", async () => {
    eventRoutes("owner");
    open(`/app/g/${G}`);
    await confirm("Delete Fall", "Delete event");
    await waitFor(() =>
      expect(called("DELETE", `/api/v1/groups/${G}/events/fall`)).toHaveLength(1),
    );
  });

  it("an admin can delete a group only once it is archived", async () => {
    routes = {
      ...base(true),
      "GET /api/v1/users": () => [200, []],
      "GET /api/v1/groups": () => [
        200,
        [group(null), group(null, { id: "g2", name: "Old", archived: true })],
      ],
      "DELETE /api/v1/groups/g2": () => [204, undefined],
    };
    open("/app/admin");
    await screen.findByRole("table", { name: /All groups/ });
    expect(screen.queryByRole("button", { name: "Delete Lab" })).toBeNull();
    await confirm("Delete Old", "Delete group");
    await waitFor(() => expect(called("DELETE", "/api/v1/groups/g2")).toHaveLength(1));
  });
});

describe("event dates (#61) and wave (#54)", () => {
  const ev = {
    id: "ev1",
    slug: "fall",
    title: "Fall",
    description: "",
    startsOn: "2026-10-01",
    endsOn: "2026-10-03",
  };
  const setup = () => {
    routes = {
      ...base(false),
      [`GET /api/v1/groups/${G}`]: () => [200, group("creator")],
      [`GET /api/v1/groups/${G}/events`]: () => [200, [ev]],
      [`GET /api/v1/groups/${G}/events/fall`]: () => [200, ev],
      "GET /api/v1/events/ev1/surveys": () => [
        200,
        [{ slug: "pre", waveLabel: "pre", closed: false, latestVersion: null }],
      ],
    };
  };

  it("sends dates when creating an event and shows them in the list", async () => {
    setup();
    routes[`PUT /api/v1/groups/${G}/events/spring`] = () => [201, { ...ev, slug: "spring" }];
    open(`/app/g/${G}`);
    expect(await screen.findByText(/2026-10-01 to 2026-10-03/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Spring" } });
    fireEvent.change(screen.getByLabelText(/Short name/), { target: { value: "spring" } });
    fireEvent.change(screen.getByLabelText(/Starts on/), { target: { value: "2027-03-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(called("PUT", `/api/v1/groups/${G}/events/spring`)[0]?.body).toEqual({
        title: "Spring",
        startsOn: "2027-03-01",
        endsOn: null,
      }),
    );
  });

  it("shows the event date, sends the wave on create and PATCHes it on change", async () => {
    setup();
    routes["PUT /api/v1/events/ev1/surveys/post"] = () => [201, { slug: "post" }];
    routes["PATCH /api/v1/events/ev1/surveys/pre"] = () => [200, { slug: "pre" }];
    open(`/app/g/${G}/e/fall`);
    expect(await screen.findByText("2026-10-01 to 2026-10-03")).toBeTruthy();
    fireEvent.change(await screen.findByDisplayValue("pre"), { target: { value: "followup" } });
    await waitFor(() =>
      expect(called("PATCH", "/api/v1/events/ev1/surveys/pre")[0]?.body).toEqual({
        waveLabel: "followup",
      }),
    );
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Post" } });
    fireEvent.change(screen.getByLabelText(/Short name/), { target: { value: "post" } });
    fireEvent.change(screen.getByDisplayValue("not a wave"), { target: { value: "post" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(called("PUT", "/api/v1/events/ev1/surveys/post")[0]?.body).toMatchObject({
        waveLabel: "post",
      }),
    );
  });
});

describe("duplicate and templates (#74)", () => {
  const fall = { id: "ev1", slug: "fall", title: "Fall", description: "" };
  const spring = { id: "ev2", slug: "spring", title: "Spring", description: "" };
  const MD = "# Post\n\n::: {.text #comments}\nAny comments?\n:::\n";
  const eventRoutes = (role: string) => {
    routes = {
      ...base(false),
      [`GET /api/v1/groups/${G}`]: () => [200, group(role)],
      [`GET /api/v1/groups/${G}/events`]: () => [200, [fall, spring]],
      [`GET /api/v1/groups/${G}/events/fall`]: () => [200, fall],
      "GET /api/v1/events/ev1/surveys": () => [
        200,
        [{ slug: "post", closed: false, latestVersion: 1, responseCount: 4 }],
      ],
      "GET /api/v1/events/ev1/surveys/post": () => [200, { slug: "post", markdown: MD }],
      "PUT /api/v1/events/ev2/surveys/post": () => [201, { slug: "post" }],
      "PUT /api/v1/events/ev1/surveys/cfde": () => [201, { slug: "cfde" }],
    };
  };

  it("a creator duplicates a survey's draft into another event of the group", async () => {
    eventRoutes("creator");
    open(`/app/g/${G}/e/fall`);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate post" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate post" });
    fireEvent.change(within(dialog).getByLabelText("Into event"), { target: { value: "ev2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(called("PUT", "/api/v1/events/ev2/surveys/post")[0]?.body).toEqual({ markdown: MD }),
    );
    await waitFor(() => expect(location.pathname).toBe(`/app/g/${G}/e/spring/s/post`));
  });

  it("explains a short name that is taken in the target event", async () => {
    eventRoutes("creator");
    routes["PUT /api/v1/events/ev1/surveys/post"] = () => [428, { error: "If-Match required" }];
    open(`/app/g/${G}/e/fall`);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate post" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate post" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    expect(await within(dialog).findByText(/already exists there/)).toBeTruthy();
  });

  it("a viewer cannot duplicate", async () => {
    eventRoutes("viewer");
    open(`/app/g/${G}/e/fall`);
    await screen.findByRole("heading", { level: 1, name: "Fall" });
    expect(screen.queryByRole("button", { name: "Duplicate post" })).toBeNull();
  });

  it("starts a new survey from the CFDE template with the given title", async () => {
    eventRoutes("creator");
    open(`/app/g/${G}/e/fall`);
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Spring check-in" },
    });
    fireEvent.change(screen.getByLabelText(/Short name for links/), { target: { value: "cfde" } });
    fireEvent.change(screen.getByLabelText(/Start from/), { target: { value: "cfde" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(called("PUT", "/api/v1/events/ev1/surveys/cfde")).toHaveLength(1));
    const put = called("PUT", "/api/v1/events/ev1/surveys/cfde")[0]?.body as { markdown: string };
    expect(put.markdown.startsWith("# Spring check-in\n")).toBe(true);
    expect(put.markdown).toContain("#affiliation");
  });
});
