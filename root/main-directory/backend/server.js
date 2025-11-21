import express from "express";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit:"10mb" }));

const REPO = process.env.REPO_ROOT;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_KEY });

// --- SEGÉD: rekurzív file listázó ---
async function listRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes:true });
  const files=[];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await listRecursive(full));
    else if (/\.(ts|js|tsx|jsx)$/.test(e.name)) files.push(full);
  }
  return files;
}

// --- PREVIEW ---
app.post("/api/harmonize/preview", async (req,res)=>{
  try {
    const comps=req.body.components;
    const map=new Map();

    // összegyűjtés
    for (const c of comps) {
      const root = path.join(REPO, c.path);
      const files = await listRecursive(root);

      for(const f of files){
        const rel=path.relative(root,f);
        if(!map.has(rel)) map.set(rel,[]);
        map.get(rel).push({
          comp:c.name,
          full:f,
          content:await fs.readFile(f,"utf8")
        });
      }
    }

    const diffs = [...map.entries()].filter(([k,v])=>v.length>1);

    let suggestions=[];

    for(const [file, versions] of diffs){
      let prompt = `
Unify all versions of file: ${file}

${versions.map(v => `
===== ${v.comp} =====
${v.content}
`).join("\n")}

Return ONLY JSON:
{
 "unified": "...",
 "why": "..."
}
`;

      const out = await client.chat.completions.create({
        model:"gpt-4.1-mini",
        response_format:{type:"json_object"},
        messages:[{role:"user", content:prompt}]
      });

      const data = out.choices[0].message.content;

      suggestions.push({ 
        file, 
        unified:data.unified, 
        why:data.why 
      });
    }

    res.json({ ok:true, suggestions });

  } catch(e){
    res.json({ ok:false, error:e.message });
  }
});


// --- APPLY (VALÓDI FELÜLÍRÁS) ---
app.post("/api/harmonize/apply", async(req,res)=>{
  try {
    const { component, suggestions } = req.body;

    if (!component || !suggestions) {
      return res.json({ ok:false, error:"component + suggestions required" });
    }

    const root = path.join(REPO, component.path);

    for (const s of suggestions) {
      const target = path.join(root, s.file);

      // mappa biztosítása
      await fs.mkdir(path.dirname(target), { recursive:true });

      // FÁJL FELÜLÍRÁS!
      await fs.writeFile(target, s.unified, "utf8");
    }

    res.json({ ok:true, applied:suggestions.length });

  } catch(e){
    res.json({ ok:false, error:e.message });
  }
});

app.listen(4000, ()=>console.log("ASA Harmonizer Backend ON :4000"));
