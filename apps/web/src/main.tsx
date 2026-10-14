import { APP_NAME } from "@plainfeedback/core";
import { createRoot } from "react-dom/client";

// biome-ignore lint/style/noNonNullAssertion: root exists in index.html
createRoot(document.getElementById("root")!).render(<h1>{APP_NAME}</h1>);
