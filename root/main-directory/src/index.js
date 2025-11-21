/**
 * ASA CODE-HARMONIZER
 * Cloudflare Worker verzió
 *
 * Fő endpointok:
 *  - GET  /health                   -> status OK
 *  - POST /harmonize/plan           -> csak elemzés, NEM ír vissza GitHubra
 *  - POST /harmonize/apply          -> elemzés + módosított package.json + új PR
 *
 * ENV változók (Cloudflare Worker bindings):
 *  - GITHUB_TOKEN           = GitHub Personal Access Token (repo joggal)
 *  - GITHUB_REPO            = "owner/repo" pl. "kbence2000/asa_full"
 *  - GITHUB_DEFAULT_BRANCH  = "main" v. "master"
 *
 * Request body (plan/apply):
 *  {
 *    "paths": ["apps", "packages"],      // opcionális, milyen gyökereket nézzen
 *    "applyMessage": "ASA auto harmonize" // csak /apply esetén PR cím/text kiegészítés
 *  }
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ ok: true, module: "ASA CODE-HARMONIZER", status: "online" });
    }

    if (request.method === "POST" && path === "/harmonize/plan") {
      return handleHarmonizePlan(request, env);
    }

    if (request.method === "POST" && path === "/harmonize/apply") {
      return handleHarmonizeApply(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

/**
 * --- High level handlers ---
 */

async function handleHarmonizePlan(request, env) {
  try {
    const body = await safeJson(request);
    const paths = body?.paths || ["apps", "packages"];

    const repoMeta = await getRepoMeta(env);
    const tree = await getGitTree(env, repoMeta.defaultBranchSha);

    const packageFiles = tree.tree.filter(
      (item) =>
        item.type === "blob" &&
        item.path.endsWith("package.json") &&
        paths.some((root) => item.path.startsWith(root + "/"))
    );

    const modules = [];
    for (const file of packageFiles) {
      const content = await getFileContent(env, file.path);
      let json;
      try {
        json = JSON.parse(content);
      } catch (e) {
        json = null;
      }

      modules.push({
        path: file.path,
        name: json?.name || guessModuleName(file.path),
        type: inferModuleType(file.path),
        packageJson: json
      });
    }

    const analysis = analyzeModules(modules);

    return jsonResponse({
      ok: true,
      mode: "plan",
      repo: env.GITHUB_REPO,
      defaultBranch: env.GITHUB_DEFAULT_BRANCH,
      summary: analysis.summary,
      suggestions: analysis.suggestions,
      modules: analysis.modulesView
    });
  } catch (e) {
    console.error("PLAN ERROR", e);
    return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function handleHarmonizeApply(request, env) {
  try {
    const body = await safeJson(request);
    const paths = body?.paths || ["apps", "packages"];
    const applyMessage = body?.applyMessage || "ASA CODE-HARMONIZER auto apply";

    const repoMeta = await getRepoMeta(env);
    const tree = await getGitTree(env, repoMeta.defaultBranchSha);

    const packageFiles = tree.tree.filter(
      (item) =>
        item.type === "blob" &&
        item.path.endsWith("package.json") &&
        paths.some((root) => item.path.startsWith(root + "/"))
    );

    // 1) Collect modules
    const modules = [];
    for (const file of packageFiles) {
      const content = await getFileContent(env, file.path);
      let json;
      try {
        json = JSON.parse(content);
      } catch (e) {
        json = null;
      }

      modules.push({
        path: file.path,
        name: json?.name || guessModuleName(file.path),
        type: inferModuleType(file.path),
        packageJson: json
      });
    }

    // 2) Analyze + get harmonized versions
    const { summary, suggestions, modulesView, harmonizedPackageJsons } =
      analyzeAndBuildHarmonized(modules);

    // 3) Create new branch, commits, PR
    const branchName = `asa-code-harmonizer-${Date.now()}`;
    const prTitle = `ASA CODE-HARMONIZER: monorepo sync (${new Date().toISOString()})`;
    const prBody = [
      "Automatikus harmonizálás ASA CODE-HARMONIZER által.",
      "",
      "Összefoglaló:",
      "- scripts és dependencies egységesítése",
      "- verziók felhúzása magasabb közös verzióra, ahol lehetett",
      "",
      "Technikai summary:",
      "```json",
      JSON.stringify(summary, null, 2),
      "```"
    ].join("\n");

    const applyResult = await applyChangesAsPR(
      env,
      repoMeta,
      harmonizedPackageJsons,
      branchName,
      prTitle,
      prBody + "\n\n" + applyMessage
    );

    return jsonResponse({
      ok: true,
      mode: "apply",
      repo: env.GITHUB_REPO,
      defaultBranch: env.GITHUB_DEFAULT_BRANCH,
      branch: branchName,
      summary,
      suggestions,
      modules: modulesView,
      pr: applyResult
    });
  } catch (e) {
    console.error("APPLY ERROR", e);
    return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
  }
}

/**
 * --- Analysis / Harmonization core ---
 */

function analyzeModules(modules) {
  // Collect scripts + dependencies cross-modules
  const scriptsMap = {};
  const depsMap = {};

  for (const m of modules) {
    const pkg = m.packageJson || {};
    const scripts = pkg.scripts || {};
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};

    for (const [k, v] of Object.entries(scripts)) {
      if (!scriptsMap[k]) scriptsMap[k] = {};
      scriptsMap[k][m.name] = v;
    }

    for (const [k, v] of Object.entries(deps)) {
      if (!depsMap[k]) depsMap[k] = {};
      depsMap[k][m.name] = v;
    }
    for (const [k, v] of Object.entries(devDeps)) {
      const key = `dev:${k}`;
      if (!depsMap[key]) depsMap[key] = {};
      depsMap[key][m.name] = v;
    }
  }

  const scriptSuggestions = buildScriptSuggestions(scriptsMap);
  const depSuggestions = buildDepSuggestions(depsMap);

  const summary = {
    moduleCount: modules.length,
    scriptKeys: Object.keys(scriptsMap).length,
    dependencyKeys: Object.keys(depsMap).length,
    scriptsNeedingSync: scriptSuggestions.filter((s) => s.kind !== "uniform").length,
    depsNeedingSync: depSuggestions.filter((d) => d.kind !== "uniform").length
  };

  const suggestions = {
    scripts: scriptSuggestions,
    dependencies: depSuggestions
  };

  const modulesView = modules.map((m) => ({
    path: m.path,
    name: m.name,
    type: m.type,
    hasPackageJson: !!m.packageJson
  }));

  return { summary, suggestions, modulesView };
}

function analyzeAndBuildHarmonized(modules) {
  const { summary, suggestions, modulesView } = analyzeModules(modules);

  // Create harmonized version of each package.json based on suggestions
  const harmonizedPackageJsons = {};

  // Build maps for quick access
  const scriptDecisions = {};
  for (const s of suggestions.scripts) {
    if (s.kind === "decision") {
      scriptDecisions[s.key] = s.recommendedValue;
    }
  }

  const depDecisions = {};
  for (const d of suggestions.dependencies) {
    if (d.kind === "decision") {
      depDecisions[d.key] = d.recommendedVersion;
    }
  }

  for (const m of modules) {
    const pkg = JSON.parse(JSON.stringify(m.packageJson || {}));

    // Harmonize scripts
    pkg.scripts = pkg.scripts || {};
    for (const [key, recommended] of Object.entries(scriptDecisions)) {
      // Only apply if this script key already exists at least in one module
      // and module either has it or missing it – we add/overwrite
      pkg.scripts[key] = recommended;
    }

    // Harmonize dependencies (including dev: prefix)
    pkg.dependencies = pkg.dependencies || {};
    pkg.devDependencies = pkg.devDependencies || {};

    for (const [depKey, version] of Object.entries(depDecisions)) {
      if (depKey.startsWith("dev:")) {
        const realKey = depKey.replace(/^dev:/, "");
        if (pkg.devDependencies[realKey]) {
          pkg.devDependencies[realKey] = version;
        }
      } else {
        if (pkg.dependencies[depKey]) {
          pkg.dependencies[depKey] = version;
        }
      }
    }

    harmonizedPackageJsons[m.path] = pkg;
  }

  return { summary, suggestions, modulesView, harmonizedPackageJsons };
}

function buildScriptSuggestions(scriptsMap) {
  const suggestions = [];

  for (const [key, moduleValues] of Object.entries(scriptsMap)) {
    const values = Object.values(moduleValues);
    const uniqueValues = Array.from(new Set(values));
    if (uniqueValues.length === 1) {
      suggestions.push({
        kind: "uniform",
        key,
        value: uniqueValues[0],
        modules: moduleValues
      });
    } else {
      // Choose the most common value as recommended
      const counts = {};
      for (const v of values) {
        counts[v] = (counts[v] || 0) + 1;
      }
      const recommendedValue = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

      suggestions.push({
        kind: "decision",
        key,
        recommendedValue,
        variants: counts,
        modules: moduleValues
      });
    }
  }

  return suggestions;
}

function buildDepSuggestions(depsMap) {
  const suggestions = [];

  for (const [key, moduleValues] of Object.entries(depsMap)) {
    const values = Object.values(moduleValues);
    const uniqueValues = Array.from(new Set(values));
    if (uniqueValues.length === 1) {
      suggestions.push({
        kind: "uniform",
        key,
        version: uniqueValues[0],
        modules: moduleValues
      });
    } else {
      // pick highest semantic-ish version string (very naive)
      const recommendedVersion = uniqueValues.sort(compareVersionDesc)[0];

      suggestions.push({
        kind: "decision",
        key,
        recommendedVersion,
        variants: uniqueValues,
        modules: moduleValues
      });
    }
  }

  return suggestions;
}

/**
 * Compare semver-like strings descending
 */
function compareVersionDesc(a, b) {
  // Strip ^, ~, etc.
  const clean = (v) => v.replace(/^[^\d]*/, "");
  const pa = clean(a).split(".").map((n) => parseInt(n || "0", 10));
  const pb = clean(b).split(".").map((n) => parseInt(n || "0", 10));

  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return -1;
    if (da < db) return 1;
  }
  return 0;
}

/**
 * --- GitHub API helpers ---
 */

async function getRepoMeta(env) {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  // Get default branch / HEAD sha
  const repoInfo = await githubRequest(env, `/repos/${owner}/${repo}`, "GET");

  const defaultBranchName = env.GITHUB_DEFAULT_BRANCH || repoInfo.default_branch;
  const branchInfo = await githubRequest(
    env,
    `/repos/${owner}/${repo}/branches/${defaultBranchName}`,
    "GET"
  );

  return {
    owner,
    repo,
    defaultBranchName,
    defaultBranchSha: branchInfo.commit.sha
  };
}

async function getGitTree(env, sha) {
  const { owner, repo } = await getRepoMeta(env);
  const tree = await githubRequest(
    env,
    `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    "GET"
  );
  return tree;
}

async function getFileContent(env, path) {
  const { owner, repo } = await getRepoMeta(env);
  const res = await githubRequest(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, "GET");
  if (!res.content) return "";
  const decoded = atob(res.content.replace(/\n/g, ""));
  return decoded;
}

/**
 * Apply changes: create branch, create blobs, tree, commit, PR
 */
async function applyChangesAsPR(
  env,
  repoMeta,
  harmonizedPackageJsons,
  branchName,
  prTitle,
  prBody
) {
  const { owner, repo, defaultBranchSha, defaultBranchName } = repoMeta;

  // 1) create branch
  await githubRequest(env, `/repos/${owner}/${repo}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: defaultBranchSha
  });

  // 2) create blobs + tree entries
  const treeEntries = [];

  for (const [path, pkgJson] of Object.entries(harmonizedPackageJsons)) {
    const content = JSON.stringify(pkgJson, null, 2) + "\n";
    const blob = await githubRequest(env, `/repos/${owner}/${repo}/git/blobs`, "POST", {
      content,
      encoding: "utf-8"
    });

    treeEntries.push({
      path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    });
  }

  const newTree = await githubRequest(env, `/repos/${owner}/${repo}/git/trees`, "POST", {
    base_tree: defaultBranchSha,
    tree: treeEntries
  });

  // 3) create commit
  const commit = await githubRequest(env, `/repos/${owner}/${repo}/git/commits`, "POST", {
    message: prTitle,
    tree: newTree.sha,
    parents: [defaultBranchSha]
  });

  // 4) update branch ref
  await githubRequest(env, `/repos/${owner}/${repo}/git/refs/heads/${branchName}`, "PATCH", {
    sha: commit.sha,
    force: true
  });

  // 5) create PR
  const pr = await githubRequest(env, `/repos/${owner}/${repo}/pulls`, "POST", {
    title: prTitle,
    head: branchName,
    base: defaultBranchName,
    body: prBody
  });

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    commitSha: commit.sha
  };
}

async function githubRequest(env, path, method = "GET", body = undefined) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN in env");

  const apiUrl = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "ASA-CODE-HARMONIZER/1.0",
    Accept: "application/vnd.github+json"
  };

  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(apiUrl, init);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error for ${path}: ${resp.status} ${text}`);
  }

  return resp.json();
}

/**
 * --- Small helpers ---
 */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function safeJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

function guessModuleName(path) {
  const parts = path.split("/");
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return path.replace("/package.json", "");
}

function inferModuleType(path) {
  if (path.startsWith("apps/")) return "app";
  if (path.startsWith("packages/")) return "package";
  return "unknown";
}
