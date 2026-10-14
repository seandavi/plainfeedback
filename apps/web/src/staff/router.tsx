// Minimal client routing for /app (History API). ponytail: no router library; add one if routes
// need nested layouts or loaders. A page with unsaved work sets a leave guard (see useLeaveGuard).
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

const EVENT = "pf:navigate";
let guard: (() => boolean) | undefined;
let current = typeof location === "undefined" ? "/" : location.pathname;

/** Returns false (and stays) if a page with unsaved work says no. */
export function navigate(to: string, { replace = false } = {}) {
  if (to === location.pathname) return true;
  if (guard && !guard()) return false;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  current = to;
  window.dispatchEvent(new Event(EVENT));
  return true;
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onNav = () => setPath(location.pathname);
    const onPop = () => {
      // Back/forward already changed the URL; undo it if the page refuses to leave.
      if (guard && location.pathname !== current && !guard()) history.pushState(null, "", current);
      current = location.pathname;
      onNav();
    };
    window.addEventListener(EVENT, onNav);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener(EVENT, onNav);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return path;
}

const MESSAGE = "You have unsaved changes. Leave this page and lose them?";

/** While `dirty`, confirm before in-app navigation and warn on tab close or reload. */
export function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    guard = () => window.confirm(MESSAGE);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      guard = undefined;
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);
}

export function Link({
  href,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={onClick} {...rest} />;
}
