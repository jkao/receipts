import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "react-data-grid/lib/styles.css";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
