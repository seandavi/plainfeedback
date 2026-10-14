// Group members and API tokens (#19), shown on the group page. Every action calls the same
// permission-checked API as everything else; hiding controls here is a convenience, never the check.
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { ApiError, api, type Group, type Me, type Role, type TokenRole } from "./api";
import { Dialog } from "./Editor";
import { ErrorNote, useLoad } from "./StaffApp";

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "never");
const ROLES: Role[] = ["owner", "creator", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, creator: 1, owner: 2 };

/** Runs a mutation, then reloads; a failure (403, 409, ...) is kept in `error` for ErrorNote. */
export function useAction(reload: () => unknown) {
  const [error, setError] = useState<unknown>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (x) {
      setError(x);
    }
  };
  return { error, setError, run };
}

/** A destructive button that asks first. Focus goes to Cancel, and back to the button on close. */
export function ConfirmButton({
  label,
  name,
  title,
  children,
  onConfirm,
}: {
  label: string;
  name: string;
  title: string;
  children: ReactNode;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  // Safari does not focus a clicked button, so Dialog cannot find the opener itself.
  const close = () => {
    setOpen(false);
    queueMicrotask(() => opener.current?.focus());
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={`${label} ${name}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <Dialog title={title} onClose={close}>
          <p>{children}</p>
          <div className="actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                onConfirm();
              }}
            >
              {label}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

const RoleSelect = ({
  label,
  value,
  onChange,
  options = ROLES,
}: {
  label: string;
  value: string;
  onChange: (r: Role) => void;
  options?: readonly string[];
}) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Role)}>
    {options.map((r) => (
      <option key={r}>{r}</option>
    ))}
  </select>
);

export function Members({ me, group, g }: { me: Me; group: Group; g: string }) {
  const members = useLoad(() => api.members(g), g);
  const { error, run } = useAction(members.reload);
  if (members.error) return <ErrorNote error={members.error} />;
  if (!members.data) return <p aria-busy="true">Loading members…</p>;
  const manage = me.isAdmin || group.role === "owner";
  const add = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const email = String(f.get("email")).trim();
    await run(async () => {
      try {
        await api.setMember(g, email, String(f.get("role")) as Role);
      } catch (x) {
        if (x instanceof ApiError && x.kind === "notFound")
          throw new Error(`No user with the email ${email}. Ask them to sign in once first.`);
        throw x;
      }
      form.reset();
    });
  };
  return (
    <section aria-labelledby="members-h">
      <h2 id="members-h">Members</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Members of {group.name}</caption>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              {manage && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.userId}>
                <th scope="row">{m.email}</th>
                <td>
                  {manage ? (
                    <RoleSelect
                      label={`Role of ${m.email}`}
                      value={m.role}
                      onChange={(role) => run(() => api.setMember(g, m.userId, role))}
                    />
                  ) : (
                    m.role
                  )}
                </td>
                {manage && (
                  <td>
                    <ConfirmButton
                      label="Remove"
                      name={m.email}
                      title="Remove member"
                      onConfirm={() => run(() => api.removeMember(g, m.userId))}
                    >
                      Remove {m.email} from {group.name}? They lose access to its events and
                      surveys, and their API tokens for it stop working.
                    </ConfirmButton>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      {manage && (
        <form className="create" onSubmit={add}>
          <fieldset>
            <legend>Add a member</legend>
            <label>
              Email <input name="email" type="email" required />
              <span className="meta">They must have signed in once.</span>
            </label>
            <label>
              Role{" "}
              <select name="role" defaultValue="viewer">
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit">Add member</button>
          </fieldset>
        </form>
      )}
    </section>
  );
}

export function Tokens({ me, group, g }: { me: Me; group: Group; g: string }) {
  const tokens = useLoad(() => api.tokens(g), g);
  const { error, run } = useAction(tokens.reload);
  const [created, setCreated] = useState<{ name: string; token: string }>();
  const [copied, setCopied] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  if (tokens.error) return <ErrorNote error={tokens.error} />;
  if (!tokens.data) return <p aria-busy="true">Loading API tokens…</p>;
  const all = me.isAdmin || group.role === "owner";
  // A token may carry at most your own role, and never owner. Admins who are not members cannot.
  const mine = group.role;
  const options = mine ? (["creator", "viewer"] as const).filter((r) => RANK[r] <= RANK[mine]) : [];
  const create = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    setCreateError(undefined);
    try {
      const t = await api.createToken(
        g,
        String(f.get("name")).trim(),
        String(f.get("role")) as TokenRole,
        Number(f.get("days")),
      );
      setCreated({ name: t.name, token: t.token });
      setCopied(false);
      form.reset();
      tokens.reload();
    } catch (x) {
      setCreateError(x);
    }
  };
  return (
    <section aria-labelledby="tokens-h">
      <h2 id="tokens-h">API tokens</h2>
      <p className="meta">
        {all ? "All tokens for this group." : "Your tokens for this group."} A token can do what you
        can do here, at most its role, until it expires or is revoked.
      </p>
      {created && (
        <div role="alert" className="secret">
          <p>
            <strong>Copy the token "{created.name}" now.</strong> It is shown only once and cannot
            be retrieved later. Treat it like a password.
          </p>
          <input
            readOnly
            aria-label="New API token"
            value={created.token}
            onFocus={(e) => e.target.select()}
          />
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                navigator.clipboard?.writeText(created.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              Copy token
            </button>
            <button type="button" onClick={() => setCreated(undefined)}>
              I have saved it
            </button>
          </div>
          {copied && <p role="status">Copied to the clipboard.</p>}
        </div>
      )}
      {tokens.data.length === 0 ? (
        <p>No tokens yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">API tokens of {group.name}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td>{t.email}</td>
                  <td>{t.role}</td>
                  <td>{when(t.createdAt)}</td>
                  <td>{when(t.expiresAt)}</td>
                  <td>{when(t.lastUsedAt)}</td>
                  <td>
                    {t.revokedAt ? (
                      "Revoked"
                    ) : (
                      <ConfirmButton
                        label="Revoke"
                        name={t.name}
                        title="Revoke token"
                        onConfirm={() => run(() => api.revokeToken(g, t.id))}
                      >
                        Revoke the token "{t.name}" ({t.email})? Anything using it stops working
                        immediately.
                      </ConfirmButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error !== undefined && <ErrorNote error={error} />}
      {options.length > 0 && (
        <form className="create" onSubmit={create}>
          <fieldset>
            <legend>New API token</legend>
            <label>
              Name <input name="name" required maxLength={200} />
            </label>
            <label>
              Role{" "}
              <select name="role" defaultValue={options[0]}>
                {options.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Expires after (days){" "}
              <input name="days" type="number" min={1} max={365} defaultValue={90} required />
            </label>
            <button type="submit">Create token</button>
            {createError !== undefined && <ErrorNote error={createError} />}
          </fieldset>
        </form>
      )}
    </section>
  );
}
