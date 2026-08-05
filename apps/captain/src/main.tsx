import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ensureMockAccess } from "./mock-mode";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root was not found");
}

ensureMockAccess();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
