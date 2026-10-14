// Typed client for the staff API (/api/v1, docs/api.md). Same-origin fetch with the session cookie;
// browsers send Origin on unsafe same-origin requests, which satisfies the server's CSRF check.
// Types mirror the schemas in docs/openapi.json (hand-written: only the fields the web app uses).
import type { CompileError, Survey as Model } from "@plainfeedback/core";

export type Role = "viewer" | "creator" | "owner";
export type Me = { id: string; email: string; isAdmin: boolean };
export type Group = { id: string; name: string; archived: boolean; role: Role | null };
export type Event = { id: string; slug: string; title: string; description: string };
export type VersionSummary = {
  version: number;
  publishedAt: string;
  opensAt: string | null;
  closesAt: string | null;
};
export type Version = VersionSummary & { markdown: string; model: Model; privacyStatement: string };
export type SurveySummary = {
  slug: string;
  waveLabel: string | null;
  closed: boolean;
  updatedAt: string;
  latestVersion: number | null;
  // Present in the list endpoint only.
  opensAt?: string | null;
  closesAt?: string | null;
  responseCount?: number;
  title?: string | null;
};
export type User = {
  id: string;
  email: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
};
export type Member = { userId: string; email: string; role: Role };
export type TokenRole = "viewer" | "creator";
export type ApiToken = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: TokenRole;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};
export type Survey = SurveySummary & {
  publicId: string;
  markdown: string;
  etag: string;
  latest: VersionSummary | null;
};
export type PublishOptions = {
  privacyStatement?: string;
  opensAt?: string | null;
  closesAt?: string | null;
};

export type ErrorKind =
  | "unauthenticated" // 401
  | "forbidden" // 403
  | "notFound" // 404 (also: not a member of the group, ADR 0009)
  | "conflict" // 409, e.g. archived group
  | "stale" // 412, If-Match no longer matches the draft
  | "invalid" // 400 and 422; compileErrors is set for an unpublishable draft
  | "other";
const KINDS: Record<number, ErrorKind> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "notFound",
  409: "conflict",
  412: "stale",
  422: "invalid",
};

export class ApiError extends Error {
  readonly kind: ErrorKind;
  constructor(
    readonly status: number,
    message: string,
    readonly compileErrors?: CompileError[],
  ) {
    super(message);
    this.kind = KINDS[status] ?? "other";
  }
}

/** One request; resolves to the JSON body (undefined for 204) and the ETag header. */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ data: T; etag: string | null }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  const json = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const j = json as { error?: string; errors?: CompileError[] } | undefined;
    throw new ApiError(res.status, j?.error ?? `Request failed (${res.status})`, j?.errors);
  }
  return { data: json as T, etag: res.headers.get("etag") };
}
const get = async <T>(path: string) => (await call<T>("GET", path)).data;
const enc = encodeURIComponent;
const survey = (eventId: string, slug: string) => `/events/${enc(eventId)}/surveys/${enc(slug)}`;

export const api = {
  me: () => get<Me>("/me"),
  logout: () => call<void>("POST", "/auth/logout"),
  groups: () => get<Group[]>("/groups"),
  users: () => get<User[]>("/users"),
  patchUser: (id: string, patch: { isAdmin?: boolean; disabled?: boolean }) =>
    call<User>("PATCH", `/users/${enc(id)}`, patch).then((r) => r.data),
  createGroup: (name: string) => call<Group>("POST", "/groups", { name }).then((r) => r.data),
  patchGroup: (g: string, patch: { name?: string; archived?: boolean }) =>
    call<Group>("PATCH", `/groups/${enc(g)}`, patch).then((r) => r.data),
  members: (g: string) => get<Member[]>(`/groups/${enc(g)}/members`),
  /** `user` is a user id or the email of someone who has signed in once. */
  setMember: (g: string, user: string, role: Role) =>
    call<Member>("PUT", `/groups/${enc(g)}/members/${enc(user)}`, { role }).then((r) => r.data),
  removeMember: (g: string, user: string) =>
    call<void>("DELETE", `/groups/${enc(g)}/members/${enc(user)}`),
  tokens: (g: string) => get<ApiToken[]>(`/groups/${enc(g)}/tokens`),
  createToken: (g: string, name: string, role: TokenRole, expiresInDays: number) =>
    call<ApiToken & { token: string }>("POST", `/groups/${enc(g)}/tokens`, {
      name,
      role,
      expiresInDays,
    }).then((r) => r.data),
  revokeToken: (g: string, id: string) =>
    call<void>("DELETE", `/groups/${enc(g)}/tokens/${enc(id)}`),
  group: (g: string) => get<Group>(`/groups/${enc(g)}`),
  events: (g: string) => get<Event[]>(`/groups/${enc(g)}/events`),
  event: (g: string, slug: string) => get<Event>(`/groups/${enc(g)}/events/${enc(slug)}`),
  putEvent: async (g: string, slug: string, title: string) =>
    (await call<Event>("PUT", `/groups/${enc(g)}/events/${enc(slug)}`, { title })).data,
  surveys: (eventId: string) => get<SurveySummary[]>(`/events/${enc(eventId)}/surveys`),
  survey: (eventId: string, slug: string) => get<Survey>(survey(eventId, slug)),
  /** Create (etag undefined) or update a draft. A stale etag throws kind "stale" (412). */
  saveDraft: async (eventId: string, slug: string, markdown: string, etag?: string) =>
    (
      await call<Survey>(
        "PUT",
        survey(eventId, slug),
        { markdown },
        etag ? { "if-match": etag } : {},
      )
    ).data,
  setClosed: (eventId: string, slug: string, closed: boolean) =>
    call<Survey>("PATCH", survey(eventId, slug), { closed }).then((r) => r.data),
  publish: (eventId: string, slug: string, opts: PublishOptions) =>
    call<Version>("POST", `${survey(eventId, slug)}/publish`, opts).then((r) => r.data),
  versions: (eventId: string, slug: string) =>
    get<VersionSummary[]>(`${survey(eventId, slug)}/versions`),
  version: (eventId: string, slug: string, n: number) =>
    get<Version>(`${survey(eventId, slug)}/versions/${n}`),
  // Deletion (#36) is permanent; the UI always confirms first.
  deleteGroup: (g: string) => call<void>("DELETE", `/groups/${enc(g)}`),
  deleteEvent: (g: string, slug: string) =>
    call<void>("DELETE", `/groups/${enc(g)}/events/${enc(slug)}`),
  deleteSurvey: (eventId: string, slug: string) => call<void>("DELETE", survey(eventId, slug)),
  /** All responses of a survey, or only those submitted before `before` (ISO). */
  deleteResponses: (eventId: string, slug: string, before?: string) =>
    call<{ deleted: number }>(
      "DELETE",
      `${survey(eventId, slug)}/responses${before ? `?before=${enc(before)}` : ""}`,
    ).then((r) => r.data),
  deleteResponse: (eventId: string, slug: string, id: string) =>
    call<void>("DELETE", `${survey(eventId, slug)}/responses/${enc(id)}`),
};

export const isOwner = (me: Me, group: Group) =>
  !group.archived && (me.isAdmin || group.role === "owner");
export const canEdit = (me: Me, group: Group) =>
  !group.archived && (me.isAdmin || group.role === "creator" || group.role === "owner");
