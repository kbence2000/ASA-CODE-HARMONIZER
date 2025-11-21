import express from "express";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const REPO = process.env.REPO_ROOT || "/home/projects/asa_full";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_KEY });

// fájl listázás
async function listRecursive(dir) {
  let entries = await fs.readdir(dir, { withFileTypes: true });
  let files = [];
  for (let e of entries) {
    let full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await listRecursive(full));
    else if (/\.(ts|js|tsx|jsx)$/.test(e.name)) files.push(full);
  }
  return files;
}

// harmonizációs endpoint
app.post("/api/harmonize/preview", async (req, res) => {
  try {
    const components = req.body.components; // [{name:"dashboard",path:"apps/dashboard"}]

    const map = new Map();

    for (const comp of components) {
      const root = path.join(REPO, comp.path);
      const files = await listRecursive(root);

      for (let f of files) {
        let rel = path.relative(root, f);
        if (!map.has(rel)) map.set(rel, []);
        map.get(rel).push({
          comp: comp.name,
          full: f,
          content: await fs.readFile(f, "utf8")
        });
      }
    }

    let diffs = [...map.entries()].filter(([k, arr]) => arr.length > 1);

    let suggestions = [];

    for (let [file, versions] of diffs) {
      let prompt = `
Unify these component versions of the same file (${file}):

${versions.map(v => `
--- ${v.comp} ---
${v.content}
`).join("\n")}

Return ONLY JSON:
{
 "unified":"<unified code>",
 "why":"<explanation>"
}
`;

      let out = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role:"user", content: prompt }],
        response_format:{ type:"json_object" }
      });

      suggestions.push({
        file,
        unified: out.choices[0].message.content.unified,
        why: out.choices[0].message.content.why
      });
    }

    res.json({ ok:true, suggestions });

  } catch (e) {
    res.json({ ok:false, error:e.message });
  }
});

app.listen(4000, () => console.log("ASA Harmonizer backend ON :4000"));
