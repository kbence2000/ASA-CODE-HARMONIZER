/**************************************************************************************************
 * ASA CODE-HARMONIZER  –  FULL STACK MODUL EGY KÓDBAN
 * - Backend (Node/Express): kód összehasonlítás + harmonizáló javaslatok (OpenAI-val)
 * - Cloudflare Worker: proxy endpoint a backend /harmonize API-hoz
 * - React ASA MATRIX panel: gomb/panel a Code Harmonizer hívására
 *
 * SZÍNPALETTA (ASA main):
 *   triple black:     #000000, #02040A, #050B14
 *   dark turquoise:   #00B7C2
 *   cyan green:       #00FF9F
 **************************************************************************************************/

/**************************************************************************************************
 * SECTION 1 – BACKEND (Node + Express + OpenAI) – file: backend/asa-code-harmonizer.ts
 **************************************************************************************************/

// package.json (backend)
/**
{
  "name": "asa-backend",
  "version": "1.0.0",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "ts-node-esm src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "express": "^4.19.0",
    "cors": "^2.8.5",
    "openai": "^4.0.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "ts-node": "^10.9.2",
    "typescript": "^5.6.0"
  }
}
*/

//////////////////////////// server.ts ////////////////////////////

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(process.cwd(), "../asa_full");

if (!OPENAI_API_KEY) {
  console.warn("[ASA] WARNING: OPENAI_API_KEY is missing – Code Harmonizer AI mode disabled");
}

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// Típusok
type HarmonizerComponent = {
  name: string;          // pl. "dashboard", "backend", "worker"
  path: string;          // repón belüli relatív mappa: "apps/dashboard"
};

type HarmonizerDiff = {
  file: string;          // relatív útvonal komponens root-hoz képest
  components: string[];  // mely komponensekben létezik
  rawContents: Record<string, string>; // { componentName: fileContent }
};

type HarmonizerSuggestion = {
  file: string;
  unifiedCode: string;
  rationale: string;
};

type HarmonizerRunResult = {
  diffs: HarmonizerDiff[];
  suggestions: HarmonizerSuggestion[];
};

/**
 * Rekurzív fájl-listázó helper
 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await listFilesRecursive(full);
      files.push(...sub);
    } else {
      // csak kód típusú fájlok
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(full);
      }
    }
  }

  return files;
}

/**
 * Összegyűjti a komponensek kódfájljait és jelzi, ha
 * ugyanazon relatív útvonalon több verzió is létezik.
 */
async function collectComponentDiffs(components: HarmonizerComponent[]): Promise<HarmonizerDiff[]> {
  const fileMap: Map<string, { component: string; fullPath: string }[]> = new Map();

  for (const comp of components) {
    const compRoot = path.join(REPO_ROOT, comp.path);
    const allFiles = await listFilesRecursive(compRoot);

    for (const f of allFiles) {
      const rel = path.relative(compRoot, f); // komponensen belüli relatív útvonal
      if (!fileMap.has(rel)) {
        fileMap.set(rel, []);
      }
      fileMap.get(rel)!.push({ component: comp.name, fullPath: f });
    }
  }

  const diffs: HarmonizerDiff[] = [];

  for (const [relPath, entries] of fileMap.entries()) {
    if (entries.length <= 1) continue; // csak akkor érdekes, ha több komponensben is létezik

    const rawContents: Record<string, string> = {};
    const componentsNames: string[] = [];

    for (const e of entries) {
      const content = await fs.readFile(e.fullPath, "utf8");
      rawContents[e.component] = content;
      componentsNames.push(e.component);
    }

    diffs.push({
      file: relPath,
      components: componentsNames,
      rawContents
    });
  }

  return diffs;
}

/**
 * AI-alapú harmonizáló javaslat: unify több komponensben lévő fájlt.
 */
async function generateUnifiedSuggestions(diffs: HarmonizerDiff[]): Promise<HarmonizerSuggestion[]> {
  if (!openai) {
    // ha nincs OpenAI kulcs, csak struktúrát adunk vissza
    return diffs.map(d => ({
      file: d.file,
      unifiedCode: "// OpenAI API key missing – manual harmonization needed.\n",
      rationale: "OpenAI disabled – please manually unify this file."
    }));
  }

  const suggestions: HarmonizerSuggestion[] = [];

  for (const diff of diffs) {
    const promptParts: string[] = [];

    promptParts.push(
      `You are ASA CODE-HARMONIZER, an autonomous refactor agent that unifies component code versions.`
    );
    promptParts.push(
      `For the same relative file path "${diff.file}" we have multiple components with different code:`
    );

    for (const compName of diff.components) {
      promptParts.push(`\n===== COMPONENT: ${compName} =====\n`);
      promptParts.push(diff.rawContents[compName].slice(0, 8000)); // safety truncation
    }

    promptParts.push(`
TASK:
- Read all versions from the components.
- Produce ONE UNIFIED version that:
  - keeps the best / most modern logic,
  - is compatible with a monorepo setup,
  - avoids hard-coded component-specific paths where possible,
  - is clean, modular, and well formatted.
- After the code, in a short explanation, describe what you unified/kept/changed.
Return response in JSON with keys: "unifiedCode", "rationale".
Use TypeScript/React/Node style as appropriate based on the inputs.
`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a senior code refactoring and harmonization AI agent." },
        { role: "user", content: promptParts.join("\n") }
      ]
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { unifiedCode: raw, rationale: "Could not parse JSON, falling back to raw string." };
    }

    suggestions.push({
      file: diff.file,
      unifiedCode: parsed.unifiedCode || "",
      rationale: parsed.rationale || ""
    });
  }

  return suggestions;
}

/**
 * REST endpoint: /api/code-harmonizer/preview
 * - bemenet: komponens lista
 * - eredmény: diffs + AI javaslat a harmonizálásra
 */
app.post("/api/code-harmonizer/preview", async (req: Request, res: Response) => {
  try {
    const components = (req.body?.components || []) as HarmonizerComponent[];

    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({ ok: false, error: "components[] is required" });
    }

    console.log("[ASA] Code Harmonizer: collecting diffs for components:", components.map(c => c.name));

    const diffs = await collectComponentDiffs(components);
    const suggestions = await generateUnifiedSuggestions(diffs);

    const result: HarmonizerRunResult = { diffs, suggestions };

    res.json({ ok: true, result });
  } catch (e: any) {
    console.error("[ASA] Harmonizer error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
});

/**
 * (opcionális) APPLY endpoint – itt valóban fájlokat ír át
 * FIGYELEM: csak akkor használd, ha biztos vagy benne!
 */
app.post("/api/code-harmonizer/apply", async (req: Request, res: Response) => {
  try {
    const { suggestions, targetComponent } = req.body as {
      suggestions: HarmonizerSuggestion[];
      targetComponent: HarmonizerComponent;
    };

    if (!suggestions?.length || !targetComponent) {
      return res.status(400).json({ ok: false, error: "suggestions[] + targetComponent required" });
    }

    const targetRoot = path.join(REPO_ROOT, targetComponent.path);

    for (const s of suggestions) {
      const fullPath = path.join(targetRoot, s.file);
      const dirName = path.dirname(fullPath);
      await fs.mkdir(dirName, { recursive: true });
      await fs.writeFile(fullPath, s.unifiedCode, "utf8");
      console.log("[ASA] Harmonizer APPLIED:", fullPath);
    }

    res.json({ ok: true, applied: suggestions.length });
  } catch (e: any) {
    console.error("[ASA] Harmonizer apply error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`[ASA] CODE-HARMONIZER backend listening on http://localhost:${PORT}`);
});


/**************************************************************************************************
 * SECTION 2 – CLOUDFLARE WORKER (proxy a backendhez) – file: worker/src/asa-code-harmonizer-worker.ts
 **************************************************************************************************/

// wrangler.toml:
/**
name = "asa-code-harmonizer-worker"
main = "src/asa-code-harmonizer-worker.ts"
compatibility_date = "2024-09-01"

[vars]
BACKEND_URL = "https://your-backend-domain.com" # pl. Cloudflare Tunnel / VPS / Render stb.
*/

//////////////////////////// asa-code-harmonizer-worker.ts ////////////////////////////

export interface Env {
  BACKEND_URL: string;
}

/**
 * Ez a Worker az ASA MATRIX-ből jövő kéréseket fogja
 * és továbbítja a backend /api/code-harmonizer/* endpointjaira.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Csak /harmonizer/... útvonalakat proxizunk
    if (!url.pathname.startsWith("/harmonizer")) {
      return new Response("ASA CODE-HARMONIZER Worker – OK", { status: 200 });
    }

    // Pl. /harmonizer/preview → backend /api/code-harmonizer/preview
    const subPath = url.pathname.replace("/harmonizer", "");
    const target = new URL(`/api/code-harmonizer${subPath}`, env.BACKEND_URL);

    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow"
    };

    return fetch(target.toString(), init);
  }
} satisfies ExportedHandler<Env>;


/**************************************************************************************************
 * SECTION 3 – ASA MATRIX REACT PANEL (VORTEX UI + BUTTON) – file: dashboard/src/ASA_CodeHarmonizerPanel.tsx
 **************************************************************************************************/

// package.json (dashboard) – fontos az endpointok miatt:
/**
{
  "name": "asa-dashboard",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  }
}
*/

//////////////////////////// ASA_CodeHarmonizerPanel.tsx ////////////////////////////

import React, { useState } from "react";

type HarmonizerComponent = {
  name: string;
  path: string;
};

type HarmonizerSuggestion = {
  file: string;
  unifiedCode: string;
  rationale: string;
};

type HarmonizerRunResult = {
  diffs: any[];
  suggestions: HarmonizerSuggestion[];
};

interface Props {
  // ASA MATRIX oldalról érkező beállítások (opcionális)
  defaultComponents?: HarmonizerComponent[];
  workerBaseUrl?: string; // pl. "https://asa-code-harmonizer-worker.example.workers.dev"
}

/**
 * ASA MATRIX -> CODE HARMONIZER PANEL
 * - triple black + dark turquoise + cyan green
 * - vortex háttér animáció
 * - egy nagy "Run Code Harmonizer" gomb
 */
export const ASA_CodeHarmonizerPanel: React.FC<Props> = ({
  defaultComponents,
  workerBaseUrl = "https://asa-code-harmonizer-worker.example.workers.dev"
}) => {
  const [components, setComponents] = useState<HarmonizerComponent[]>(
    defaultComponents || [
      { name: "dashboard", path: "apps/dashboard" },
      { name: "backend", path: "apps/backend" },
      { name: "worker", path: "apps/worker" }
    ]
  );

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HarmonizerRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runHarmonizerPreview() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const resp = await fetch(`${workerBaseUrl}/harmonizer/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ components })
      });

      const data = await resp.json();
      if (!data.ok) {
        throw new Error(data.error || "Unknown harmonizer error");
      }

      setResult(data.result as HarmonizerRunResult);
    } catch (e: any) {
      setError(e?.message || "Harmonizer request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="asa-harmonizer-root">
      <div className="asa-vortex-bg" />
      <div className="asa-panel">
        <header className="asa-panel-header">
          <h2>ASA CODE-HARMONIZER</h2>
          <p>Auto-compare & unify code across ASA MATRIX components.</p>
        </header>

        <section className="asa-panel-components">
          <h3>Target Components</h3>
          <ul>
            {components.map((c, idx) => (
              <li key={idx}>
                <span className="tag-name">{c.name}</span>
                <span className="tag-path">{c.path}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="asa-panel-actions">
          <button
            className="asa-button-primary"
            disabled={loading}
            onClick={runHarmonizerPreview}
          >
            {loading ? "Analyzing & Harmonizing..." : "Run Code Harmonizer"}
          </button>
        </section>

        {error && (
          <section className="asa-panel-error">
            <p>{error}</p>
          </section>
        )}

        {result && (
          <section className="asa-panel-result">
            <h3>Suggestions</h3>
            {result.suggestions.length === 0 && <p>No overlapping files detected.</p>}

            {result.suggestions.map((s, idx) => (
              <details key={idx} className="asa-suggestion">
                <summary>{s.file}</summary>
                <div className="asa-suggestion-body">
                  <pre className="asa-code-block">
                    <code>{s.unifiedCode}</code>
                  </pre>
                  <p className="asa-rationale">{s.rationale}</p>
                </div>
              </details>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};


/**************************************************************************************************
 * SECTION 4 – ASA MATRIX MAIN DASHBOARD INTEGRÁCIÓ – file: dashboard/src/ASA_Matrix.tsx
 **************************************************************************************************/

import React from "react";
import { ASA_CodeHarmonizerPanel } from "./ASA_CodeHarmonizerPanel";

export const ASA_Matrix: React.FC = () => {
  return (
    <div className="asa-matrix-root">
      <nav className="asa-matrix-nav">
        <div className="logo-glow">ASA MATRIX</div>
        <div className="nav-buttons">
          <button className="nav-btn">Agents</button>
          <button className="nav-btn">Missions</button>
          <button className="nav-btn nav-btn-active">Code Harmonizer</button>
        </div>
      </nav>

      <main className="asa-matrix-main">
        <ASA_CodeHarmonizerPanel />
      </main>
    </div>
  );
};


/**************************************************************************************************
 * SECTION 5 – VORTEX + TRIPLE-BLACK THEME CSS – file: dashboard/src/asa-theme.css
 **************************************************************************************************/

/**
 * Triple black + dark turquoise (#00B7C2) + cyan green (#00FF9F)
 * + glowok, vortex mozgatott háttér animáció.
 */

:root {
  --asa-black-0: #000000;
  --asa-black-1: #02040a;
  --asa-black-2: #050b14;
  --asa-turquoise: #00b7c2;
  --asa-cyan: #00ff9f;
  --asa-text: #e8f7ff;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  background-color: var(--asa-black-0);
  color: var(--asa-text);
}

.asa-harmonizer-root {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  background: radial-gradient(circle at top left, #05121f 0, var(--asa-black-0) 45%);
}

.asa-vortex-bg {
  position: absolute;
  inset: -30%;
  background:
    radial-gradient(circle at 20% 20%, rgba(0, 183, 194, 0.35), transparent 60%),
    radial-gradient(circle at 80% 70%, rgba(0, 255, 159, 0.25), transparent 65%);
  mix-blend-mode: screen;
  filter: blur(2px);
  opacity: 0.8;
  animation: asa-vortex-rotate 26s linear infinite;
  pointer-events: none;
}

@keyframes asa-vortex-rotate {
  0% {
    transform: rotate(0deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(1.1);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
}

.asa-panel {
  position: relative;
  margin: 4rem auto;
  max-width: 1100px;
  padding: 2rem 2.5rem;
  border-radius: 24px;
  background: linear-gradient(135deg, rgba(2, 4, 10, 0.96), rgba(5, 11, 20, 0.98));
  box-shadow:
    0 0 40px rgba(0, 0, 0, 0.9),
    0 0 80px rgba(0, 183, 194, 0.28),
    0 0 120px rgba(0, 255, 159, 0.24);
  border: 1px solid rgba(0, 255, 159, 0.18);
  backdrop-filter: blur(18px);
}

.asa-panel-header h2 {
  margin: 0 0 0.25rem 0;
  font-size: 1.5rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--asa-cyan);
}

.asa-panel-header p {
  margin: 0;
  color: rgba(232, 247, 255, 0.7);
  font-size: 0.9rem;
}

.asa-panel-components {
  margin-top: 2rem;
}

.asa-panel-components h3 {
  margin: 0 0 0.75rem 0;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: rgba(232, 247, 255, 0.6);
}

.asa-panel-components ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.65rem;
}

.asa-panel-components li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.9rem;
  border-radius: 999px;
  background: radial-gradient(circle at 0 0, rgba(0, 183, 194, 0.16), rgba(5, 11, 20, 0.98));
  border: 1px solid rgba(0, 183, 194, 0.3);
}

.tag-name {
  font-weight: 600;
  color: var(--asa-turquoise);
}

.tag-path {
  font-size: 0.8rem;
  opacity: 0.75;
}

.asa-panel-actions {
  margin-top: 2rem;
  display: flex;
  justify-content: flex-start;
}

.asa-button-primary {
  position: relative;
  padding: 0.9rem 1.8rem;
  border-radius: 999px;
  border: 0;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--asa-black-2);
  background: radial-gradient(circle at 0 0, var(--asa-cyan), var(--asa-turquoise));
  box-shadow:
    0 0 18px rgba(0, 255, 159, 0.5),
    0 0 40px rgba(0, 183, 194, 0.4);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}

.asa-button-primary:hover:not(:disabled) {
  transform: translateY(-1px) scale(1.02);
  filter: brightness(1.05);
  box-shadow:
    0 0 26px rgba(0, 255, 159, 0.7),
    0 0 60px rgba(0, 183, 194, 0.6);
}

.asa-button-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.asa-panel-error {
  margin-top: 1.5rem;
  padding: 0.75rem 1rem;
  border-radius: 12px;
  background: rgba(140, 30, 30, 0.26);
  border: 1px solid rgba(255, 80, 80, 0.55);
  font-size: 0.85rem;
}

.asa-panel-result {
  margin-top: 2rem;
}

.asa-panel-result h3 {
  font-size: 0.98rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(232, 247, 255, 0.7);
  margin-bottom: 0.75rem;
}

.asa-suggestion {
  margin-bottom: 0.9rem;
  border-radius: 14px;
  background: rgba(2, 4, 10, 0.85);
  border: 1px solid rgba(0, 183, 194, 0.35);
  overflow: hidden;
}

.asa-suggestion summary {
  cursor: pointer;
  padding: 0.65rem 0.9rem;
  font-size: 0.9rem;
  color: var(--asa-turquoise);
  user-select: none;
}

.asa-suggestion-body {
  padding: 0.6rem 0.9rem 0.9rem 0.9rem;
}

.asa-code-block {
  max-height: 260px;
  overflow: auto;
  padding: 0.75rem;
  border-radius: 10px;
  background: radial-gradient(circle at 0 0, #02040a, #050b14);
  font-family: "JetBrains Mono", "SF Mono", Menlo, Monaco, monospace;
  font-size: 0.75rem;
  color: #ddf5ff;
}

.asa-rationale {
  margin-top: 0.6rem;
  font-size: 0.8rem;
  color: rgba(232, 247, 255, 0.75);
}

/* ASA MATRIX NAV */

.asa-matrix-root {
  min-height: 100vh;
  background: radial-gradient(circle at top, #050b14 0, #000000 55%);
  color: var(--asa-text);
}

.asa-matrix-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.1rem 2rem;
  border-bottom: 1px solid rgba(0, 183, 194, 0.4);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.96), rgba(5, 11, 20, 0.96));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.9);
}

.logo-glow {
  font-weight: 700;
  letter-spacing: 0.32em;
  font-size: 0.78rem;
  text-transform: uppercase;
  color: var(--asa-cyan);
  text-shadow:
    0 0 10px rgba(0, 255, 159, 0.9),
    0 0 24px rgba(0, 183, 194, 0.9);
}

.nav-buttons {
  display: flex;
  gap: 0.45rem;
}

.nav-btn {
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 183, 194, 0.4);
  background: rgba(2, 4, 10, 0.8);
  color: rgba(232, 247, 255, 0.75);
  font-size: 0.78rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.nav-btn:hover {
  background: rgba(0, 183, 194, 0.16);
  color: var(--asa-cyan);
}

.nav-btn-active {
  background: radial-gradient(circle at 0 0, var(--asa-cyan), var(--asa-turquoise));
  color: var(--asa-black-2);
  border-color: rgba(0, 255, 159, 0.9);
}

.asa-matrix-main {
  padding: 1.5rem 1.2rem 3rem 1.2rem;
}

/**************************************************************************************************
 * HASZNÁLAT / BEKÖTÉS LÉPÉSEK RÖVIDEN
 *
 * 1) Backend:
 *    - Hozd létre: backend/src/server.ts (a fenti backend rész)
 *    - .env:
 *        OPENAI_API_KEY=sk-...
 *        REPO_ROOT=/abszolut/elérési/út/asa_full
 *    - npm install
 *    - npm run dev
 *
 * 2) Worker:
 *    - Hozd létre: worker/src/asa-code-harmonizer-worker.ts
 *    - wrangler.toml-ban BACKEND_URL = a backend publikus URL-je
 *    - wrangler deploy
 *
 * 3) Dashboard (ASA MATRIX):
 *    - Importáld az ASA_Matrix-et fő App-ba
 *    - import "./asa-theme.css"
 *    - a panel a Worker /harmonizer/preview endpointját fogja hívni
 *
 * 4) Eredmény:
 *    - ASA MATRIX UI-ban Code Harmonizer tab/panel
 *    - gomb: OpenAI-val harmonizált kód preview
 *    - ha akarod, /apply endpointtal valódi fájlokra is applyolható
 **************************************************************************************************/
