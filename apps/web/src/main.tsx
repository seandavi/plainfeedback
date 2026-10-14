import "./zod-jitless"; // first: see the file
import { APP_NAME } from "@plainfeedback/core";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ParticipantPage } from "./ParticipantPage";
import "./styles.css";

// Loaded on demand so participants never download the editor (CodeMirror).
const StaffApp = lazy(() => import("./staff/StaffApp").then((m) => ({ default: m.StaffApp })));

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
    <main>
      <h1>{APP_NAME}</h1>
      <p>
        <a href="/app">Staff sign-in</a>
      </p>
    </main>
  ),
);
