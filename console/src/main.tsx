// Entry: the shared nav and status pills come from brand.js; the console itself is React.
import { createRoot } from "react-dom/client";
import { App, startTour } from "./App";
import "./console.css";

window.TW.mountNav("console");
window.TW.renderModes(document.getElementById("modes"));
const tourBtn = document.getElementById("tour-btn");
if (tourBtn) tourBtn.onclick = startTour;
createRoot(document.getElementById("root")!).render(<App />);
