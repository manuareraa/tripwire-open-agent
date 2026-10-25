import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = `http://localhost:${process.env.API_PORT ?? 8000}`;

// The console is a React app built from console/. web/ is its public folder: the landing page and the shared
// brand.js/brand.css are copied as-is, so web-dist/ ends up as the whole site and Hono serves it.
export default defineConfig({
  root,
  base: "/",
  publicDir: `${root}../web`,
  plugins: [react()],
  build: {
    outDir: `${root}../web-dist`,
    emptyOutDir: true,
    assetsDir: "console",
    rollupOptions: { input: { app: `${root}app.html` } },
  },
  // `npm run dev:web`: Vite on 5173 with hot reload, API calls passed through to the Hono server.
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/health", "/run", "/decisions", "/changes", "/suppliers", "/trace"].map((p) => [p, api])),
  },
});
