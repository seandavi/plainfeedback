// Admin area (#19): users, groups, group owners. Shown to admins only, but the API is the check.
import { type FormEvent, useState } from "react";
import { ApiError, api, type Group, type Me } from "./api";
import { ConfirmButton, useAction, when } from "./Manage";
import { Link } from "./router";
import { ErrorNote, paths, useLoad } from "./StaffApp";

export function AdminPage({ me }: { me: Me }) {
  if (!me.isAdmin) return <p role="alert">Only admins can open this page.</p>;
  return (
    <>
      <h1>Administration</h1>
      <Users me={me} />
      <Groups />
    </>
  );
}

function Users({ me }: { me: Me }) {
  const users = useLoad(api.users, "users");
  const { error, run } = useAction(users.reload);
  if (users.error) return <ErrorNote error={users.error} />;
  if (!users.data) return <p aria-busy="true">Loading users…</p>;
  return (
    <section aria-labelledby="users-h">
      <h2 id="users-h">Users</h2>
      <section
        className="table-wrap"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-focusable
        tabIndex={0}
        aria-label={"Users who have signed in"}
      >
        <table>
          <caption className="sr-only">Users who have signed in</caption>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Admin</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <th scope="row">{u.email}</th>
                <td>{u.isAdmin ? "Yes" : "No"}</td>
                <td>{when(u.createdAt)}</td>
                <td>
                  {u.isAdmin ? (
                    <ConfirmButton
                      label="Revoke admin"
                      name={u.email}
                      title="Revoke admin"
                      onConfirm={() => run(() => api.setAdmin(u.id, false))}
                    >
                      {u.id === me.id
                        ? "Revoke your own admin access"
                        : `Revoke admin for ${u.email}`}
                      ? The last admin cannot be revoked.
                    </ConfirmButton>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Grant admin ${u.email}`}
                      onClick={() => run(() => api.setAdmin(u.id, true))}
                    >
                      Grant admin
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {error !== undefined && <ErrorNote error={error} />}
    </section>
  );
}

function Groups() {
  const groups = useLoad(api.groups, "groups");
  const { error, setError, run } = useAction(groups.reload);
  const [renaming, setRenaming] = useState<string>();
  if (groups.error) return <ErrorNote error={groups.error} />;
  if (!groups.data) return <p aria-busy="true">Loading groups…</p>;
  const list = groups.data;

  const create = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const name = String(new FormData(form).get("name")).trim();
    return run(async () => {
      await api.createGroup(name);
      form.reset();
    });
  };
  const rename = (ev: FormEvent<HTMLFormElement>, g: Group) => {
    ev.preventDefault();
    const name = String(new FormData(ev.currentTarget).get("name")).trim();
    return run(async () => {
      await api.patchGroup(g.id, { name });
      setRenaming(undefined);
    });
  };
  const assign = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const email = String(f.get("email")).trim();
    return run(async () => {
      try {
        await api.setMember(String(f.get("group")), email, "owner");
      } catch (x) {
        if (x instanceof ApiError && x.kind === "notFound")
          throw new Error(`No user with the email ${email}. Ask them to sign in once first.`);
        throw x;
      }
      form.reset();
    });
  };

  return (
    <section aria-labelledby="groups-h">
      <h2 id="groups-h">Groups</h2>
      <section
        className="table-wrap"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-focusable
        tabIndex={0}
        aria-label={"All groups, including archived ones"}
      >
        <table>
          <caption className="sr-only">All groups, including archived ones</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.id}>
                <th scope="row">
                  {renaming === g.id ? (
                    <form className="inline" onSubmit={(ev) => rename(ev, g)}>
                      <input
                        name="name"
                        aria-label={`New name for ${g.name}`}
                        defaultValue={g.name}
                        required
                        maxLength={200}
                      />
                      <button type="submit">Save</button>
                      <button type="button" onClick={() => setRenaming(undefined)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <Link href={paths.group(g.id)}>{g.name}</Link>
                  )}
                </th>
                <td>{g.archived ? "Archived" : "Active"}</td>
                <td>
                  <button
                    type="button"
                    aria-label={`Rename ${g.name}`}
                    onClick={() => setRenaming(g.id)}
                  >
                    Rename
                  </button>{" "}
                  {g.archived ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Unarchive ${g.name}`}
                        onClick={() => run(() => api.patchGroup(g.id, { archived: false }))}
                      >
                        Unarchive
                      </button>{" "}
                      <ConfirmButton
                        label="Delete"
                        name={g.name}
                        title="Delete group"
                        onConfirm={() => run(() => api.deleteGroup(g.id))}
                      >
                        Permanently delete {g.name} with all its events, surveys and responses? This
                        cannot be undone. Backups keep a copy until they expire.
                      </ConfirmButton>
                    </>
                  ) : (
                    <ConfirmButton
                      label="Archive"
                      name={g.name}
                      title="Archive group"
                      onConfirm={() => run(() => api.patchGroup(g.id, { archived: true }))}
                    >
                      Archive {g.name}? Its events and surveys become read-only and stop accepting
                      changes. You can unarchive it later.
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {error !== undefined && <ErrorNote error={error} />}
      <form className="create" onSubmit={create} onChange={() => setError(undefined)}>
        <fieldset>
          <legend>Create a group</legend>
          <label>
            Name <input name="name" required maxLength={200} />
          </label>
          <button type="submit">Create group</button>
        </fieldset>
      </form>
      {list.length > 0 && (
        <form className="create" onSubmit={assign}>
          <fieldset>
            <legend>Assign a group owner</legend>
            <label>
              Group{" "}
              <select name="group" required>
                {list.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Owner email <input name="email" type="email" required />
              <span className="meta">They must have signed in once.</span>
            </label>
            <button type="submit">Make owner</button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
