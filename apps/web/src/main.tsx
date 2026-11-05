import "./zod-jitless"; // first: see the file
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ParticipantPage } from "./ParticipantPage";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "./styles.css";

// Loaded on demand so participants never download the editor (CodeMirror).
const StaffApp = lazy(() => import("./staff/StaffApp").then((m) => ({ default: m.StaffApp })));
const Landing = lazy(() => import("./Landing").then((m) => ({ default: m.Landing })));

const path = location.pathname;
const survey = /^\/s\/([^/]+)\/?$/.exec(path);

// biome-ignore lint/style/noNonNullAssertion: root exists in index.html
createRoot(document.getElementById("root")!).render(
  survey ? (
    <ParticipantPage publicId={decodeURIComponent(survey[1] ?? "")} />
  ) : /^\/app(\/|$)/.test(path) ? (
    <Suspense fallback={<p aria-busy="true">Loading…</p>}>
      <StaffApp />
    </Suspense>
  ) : (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  ),
);
