import { useState, useEffect } from "react";

export default function App() {
  const [status, setStatus] = useState<"loading"|"ready"|"authorized"|"error">("loading");
  const [info, setInfo]     = useState<{username?:string; address?:string}>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (!tg?.initData) { setStatus("error"); setMessage("Open from Telegram only."); return; }
    tg.ready(); tg.expand();

    // Look up who this Telegram user is
    fetch("/api/miniapp/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tgInitData: tg.initData }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) { setInfo({ username: d.username, address: d.address }); }
        setStatus("ready");
      })
      .catch(() => setStatus("ready"));
  }, []);

  async function authorize() {
    const tg = (window as any).Telegram?.WebApp;
    setStatus("loading");
    try {
      const res  = await fetch("/api/miniapp/authorize", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tgInitData: tg.initData }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message ?? data.error);
      setInfo(prev => ({ ...prev, ...data }));
      setStatus("authorized");
      setTimeout(() => tg?.close(), 1500);
    } catch(e: any) {
      setMessage(e.message ?? "Failed");
      setStatus("ready");
    }
  }

  const s: Record<string, React.CSSProperties> = {
    wrap:   { minHeight:"100vh", background:"#0c0c0c", color:"#fff", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"28px 20px", fontFamily:"Inter,system-ui,sans-serif", gap:20 },
    logo:   { fontSize:48, color:"#89AACC" },
    title:  { fontSize:24, fontWeight:700, letterSpacing:"0.05em", marginBottom:4 },
    sub:    { color:"#666", fontSize:14, marginBottom:24 },
    card:   { background:"#111", border:"1px solid #222", borderRadius:16, padding:24, width:"100%", maxWidth:360, textAlign:"center" as any },
    addr:   { color:"#89AACC", fontFamily:"monospace", fontSize:13, marginTop:4 },
    btn:    { width:"100%", background:"#fff", color:"#000", border:"none", borderRadius:12, padding:14, fontSize:16, fontWeight:600, cursor:"pointer", marginTop:16 },
    ok:     { color:"#4ade80", fontSize:40 },
    err:    { color:"#f87171", fontSize:13, marginTop:8 },
    muted:  { color:"#666", fontSize:14 },
  };

  if (status === "loading") return (
    <div style={s.wrap}>
      <div style={s.logo}>⬡</div>
      <p style={s.muted}>Loading...</p>
    </div>
  );

  if (status === "error") return (
    <div style={s.wrap}>
      <div style={s.logo}>⬡</div>
      <p style={{ color:"#f87171" }}>{message}</p>
    </div>
  );

  if (status === "authorized") return (
    <div style={s.wrap}>
      <div style={s.logo}>⬡</div>
      <div style={s.card}>
        <div style={s.ok}>✓</div>
        <p style={{ color:"#4ade80", fontWeight:600, fontSize:18, marginTop:8 }}>Authorized!</p>
        {info.username && <p style={s.muted}>@{info.username}</p>}
        <p style={s.muted}>Go back to Telegram.</p>
      </div>
    </div>
  );

  return (
    <div style={s.wrap}>
      <div style={s.logo}>⬡</div>
      <div style={{ textAlign:"center" as any }}>
        <div style={s.title}>NEXAR</div>
        <div style={s.sub}>Private Intelligence Graph</div>
      </div>

      <div style={s.card}>
        {info.username ? (
          <>
            <p style={{ color:"#aaa", fontSize:14 }}>Signed in as</p>
            <p style={{ color:"#fff", fontWeight:600, fontSize:18 }}>@{info.username}</p>
            {info.address && <p style={s.addr}>{info.address.slice(0,6)}...{info.address.slice(-4)}</p>}
            <button style={s.btn} onClick={authorize}>Authorize NEXAR</button>
          </>
        ) : (
          <>
            <p style={{ color:"#aaa", fontSize:14, marginBottom:8 }}>Register via the bot first:</p>
            <p style={{ color:"#fff", fontFamily:"monospace", fontSize:15 }}>register yourhandle</p>
            <p style={{ color:"#666", fontSize:13, marginTop:8 }}>Then come back here to authorize.</p>
          </>
        )}
        {message && <p style={s.err}>{message}</p>}
      </div>
    </div>
  );
}
