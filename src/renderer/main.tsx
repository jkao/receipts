import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "react-data-grid/lib/styles.css";
import App from "./App";
import "./styles/base-shell.css";
import "./styles/invoice-workspace.css";
import "./styles/onboarding-modals.css";
import "./styles/receipt-details.css";
import "./styles/notifications.css";
import "./styles/responsive.css";

const root = document.getElementById("root");

if (!root) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
