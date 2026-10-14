import { APP_NAME } from "@plainfeedback/core";
import { createRoot } from "react-dom/client";
import { ParticipantPage } from "./ParticipantPage";
import "./styles.css";

const survey = /^\/s\/([^/]+)\/?$/.exec(location.pathname);

// biome-ignore lint/style/noNonNullAssertion: root exists in index.html
createRoot(document.getElementById("root")!).render(
  survey ? <ParticipantPage publicId={decodeURIComponent(survey[1] ?? "")} /> : <h1>{APP_NAME}</h1>,
);
