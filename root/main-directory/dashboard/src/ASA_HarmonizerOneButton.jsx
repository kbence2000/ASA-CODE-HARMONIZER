import React, { useState } from "react";

export default function ASA_HarmonizerOneButton({ worker }) {
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState(null);
  const [error, setError] = useState(null);

  async function run() {
    setLoading(true);
    setOut(null);
    setError(null);

    try {
      const res = await fetch(worker + "/harmonize/preview", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          components: [
            { name:"dashboard", path:"apps/dashboard" },
            { name:"backend", path:"apps/backend" },
            { name:"worker", path:"apps/worker" }
          ]
        })
      });

      const json = await res.json();
      if (!json.ok) throw new Error(json.error);

      setOut(json.suggestions);

    } catch(e) {
      setError(e.message);
    }

    setLoading(false);
  }

  return (
    <div style={box}>
      <button style={btn} onClick={run} disabled={loading}>
        {loading ? "Harmonizing..." : "Run Code Harmonizer"}
      </button>

      {error && <div style={errBox}>{error}</div>}

      {out && out.map((s,i)=>(
        <div key={i} style={resultBox}>
          <h4>{s.file}</h4>
          <pre style={code}>{s.unified}</pre>
          <p>{s.why}</p>
        </div>
      ))}
    </div>
  );
}

const box = {
  padding: "20px",
  background: "#000",
  color:"#0ff",
  fontFamily:"monospace"
};

const btn = {
  padding:"12px 20px",
  background:"#00B7C2",
  border:"none",
  color:"#000",
  fontSize:"16px",
  cursor:"pointer",
  borderRadius:"8px"
};

const errBox = {
  padding:"10px",
  background:"#330",
  marginTop:"12px"
};

const resultBox = {
  padding:"12px",
  marginTop:"14px",
  background:"#02040A",
  border:"1px solid #00FF9F"
};

const code = {
  fontSize:"13px",
  whiteSpace:"pre-wrap",
  color:"#0FF"
};
