import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ensureMockAccess } from "./mock-mode";
import "./styles.css";

const root = document.getElementById("root");
const AdminApp = lazy(async () => {
  const module = await import("./admin/AdminApp");
  return { default: module.AdminApp };
});

if (!root) {
  throw new Error("Application root was not found");
}

const isAdmin = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
if (!isAdmin) ensureMockAccess();

createRoot(root).render(
  <StrictMode>
    {isAdmin
      ? <Suspense fallback={<main style={{ minHeight: "100vh", background: "#080a08" }} />}><AdminApp /></Suspense>
      : <App />}
  </StrictMode>
);
