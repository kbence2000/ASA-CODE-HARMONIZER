import React, { useState } from "react";

export default function ASA_Harmonizer({ worker }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [applyMode, setApplyMode] = useState(false);
  const [error, setError] = useState(null);

  const COMPONENT = { name:"backend", path:"apps/backend" };

  async function preview() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(worker + "/harmonize/preview", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          components:[
            {name:"dashboard", path:"apps/dashboard"},
            {name:"backend", path:"apps/backend"},
            {name:"worker", path:"apps/worker"}
          ]
        })
      });

      const json = await res.json();
      if (!json.ok) throw new Error(json.error);

      setResult(json.suggestions);

    } catch(e){ setError(e.message); }

    setLoading(false);
  }

  async function apply() {
    if (!result) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(worker + "/harmonize/apply", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          component: COMPONENT,
          suggestions: result
        })
      });

      const json = await res.json();
      if (!json.ok) throw new Error(json.error);

      alert("Harmonizer applied: " + json.applied + " files!");

    } catch(e){ setError(e.message); }

    setLoading(false);
  }

  return (
    <div style={root}>
      <div style={vortex}></div>
      <div style={panel}>

        <h2 style={title}>ASA CODE HARMONIZER</h2>

        {!result && (
          <button style={button} disabled={loading} onClick={preview}>
            {loading ? "Analyzing..." : "RUN PREVIEW"}
          </button>
        )}

        {result && (
          <>
            <button style={applyButton} disabled={loading} onClick={apply}>
              {loading ? "Applying..." : "APPLY CHANGES"}
            </button>

            <div style={scroll}>
              {result.map((s,i)=>(
                <div key={i} style={fileBox}>
                  <h4>{s.file}</h4>
                  <pre style={code}>{s.unified}</pre>
                  <p style={why}>{s.why}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <div style={err}>{error}</div>}
      </div>
    </div>
  );
}


/* --- ASA UI STYLES (TRIPLE-BLACK + TURQUOISE + CYAN + VORTEX) --- */

const root = {
  position:"relative",
  minHeight:"100vh",
  background:"#000",
  overflow:"hidden",
  fontFamily:"Inter, monospace"
};

const vortex = {
  position:"absolute",
  inset:"-20%",
  background:`
    radial-gradient(circle at 20% 20%, rgba(0,255,159,0.23), transparent 60%),
    radial-gradient(circle at 80% 70%, rgba(0,183,194,0.22), transparent 60%)
  `,
  animation:"spin 20s linear infinite",
  filter:"blur(20px)"
};

const panel = {
  position:"relative",
  margin:"50px auto",
  maxWidth:"900px",
  background:"rgba(0,0,0,0.7)",
  border:"1px solid #00ff9f55",
  boxShadow:"0 0 40px #00ff9f33",
  padding:"20px 30px",
  borderRadius:"20px",
  backdropFilter:"blur(12px)",
  color:"#0FF"
};

const title = {
  fontFamily:"monospace",
  letterSpacing:"0.15em",
  fontSize:"20px",
  color:"#00FF9F",
  textShadow:"0 0 10px #00ff9f"
};

const button = {
  padding:"12px 22px",
  fontSize:"16px",
  fontWeight:"600",
  background:"#00B7C2",
  color:"#000",
  border:"none",
  borderRadius:"10px",
  cursor:"pointer",
  width:"100%"
};

const applyButton = {
  ...button,
  background:"#00FF9F",
  color:"#000",
  marginBottom:"20px"
};

const scroll = {
  maxHeight:"500px",
  overflowY:"auto",
  border:"1px solid #00ff9f33",
  padding:"10px",
  borderRadius:"12px"
};

const fileBox = {
  padding:"10px",
  marginBottom:"12px",
  background:"#02040A",
  border:"1px solid #00ff9f",
  borderRadius:"10px"
};

const code = { whiteSpace:"pre-wrap", fontSize:"12px", color:"#0ff" };

const why = { fontSize:"12px", color:"#A0FFF0" };

const err = {
  background:"#400",
  color:"#fff",
  padding:"8px",
  marginTop:"15px",
  borderRadius:"8px",
  border:"1px solid #f00"
};
