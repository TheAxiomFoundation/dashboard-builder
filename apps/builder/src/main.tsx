import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@axiom-foundation/ui/tokens.css";
import "@dashboard-builder/render/styles.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
