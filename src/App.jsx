import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import ReceiveStock from "./ReceiveStock";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area } from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
// Store API URL so standalone HTML pages (like receive-stock.html) can find it
try { localStorage.setItem("starmart_api_url", API_URL); } catch {}

// ── OFFLINE — IndexedDB helpers ──────────────────────────────────────────────
const IDB_NAME = "starmart_v1";
/* ══════════ ERROR BOUNDARY ══════════ */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      const { fallback, name = "section" } = this.props;
      if (fallback) return fallback;
      return (
        <div style={{
          padding: "20px 24px", margin: "12px", borderRadius: 12,
          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)",
          color: "#F0F2F5", fontFamily: "sans-serif"
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "#FCA5A5" }}>
            ⚠️ {name} failed to load
          </div>
          <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 12 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.4)",
              background: "transparent", color: "#FCA5A5", cursor: "pointer", fontSize: 13 }}>
            🔄 Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


function idbOpen(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(IDB_NAME,2);
    r.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains("products"))
        db.createObjectStore("products",{keyPath:"id"});
      if(!db.objectStoreNames.contains("queue"))
        db.createObjectStore("queue",{keyPath:"tmpId",autoIncrement:true});
    };
    r.onsuccess=e=>res(e.target.result);
    r.onerror=()=>rej(r.error);
  });
}
async function idbGetAll(store){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,"readonly");
    const rq=tx.objectStore(store).getAll();
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error);
  });
}
async function idbPutAll(store,items){
  if(!items.length)return;
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,"readwrite");
    const os=tx.objectStore(store);
    items.forEach(i=>os.put(i));
    tx.oncomplete=res;
    tx.onerror=()=>rej(tx.error);
  });
}
async function idbClearAndPutAll(store, items) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    os.clear();
    items.forEach(i => os.put(i));
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbAdd(store,item){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,"readwrite");
    const rq=tx.objectStore(store).add(item);
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error);
  });
}
async function idbDelete(store,key){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete=res;
    tx.onerror=()=>rej(tx.error);
  });
}

// ── ONLINE STATUS HOOK ───────────────────────────────────────────────────────
function useOnlineStatus(){
  const [online,setOnline]=useState(()=>navigator.onLine);
  useEffect(()=>{
    const on=()=>setOnline(true);
    const off=()=>setOnline(false);
    window.addEventListener("online",on);
    window.addEventListener("offline",off);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[]);
  return online;
}

// ── BRANCH HELPERS ───────────────────────────────────────────────────────────
function getActiveBranch(){try{return JSON.parse(localStorage.getItem("starmart_branch")||"null");}catch{return null;}}
function saveActiveBranch(b){b?localStorage.setItem("starmart_branch",JSON.stringify(b)):localStorage.removeItem("starmart_branch");}

// ── Responsive ────────────────────────────────────────────────────────────────
function useWindowSize(){
  const [w,setW]=React.useState(window.innerWidth);
  React.useEffect(()=>{
    const fn=()=>setW(window.innerWidth);
    window.addEventListener("resize",fn);
    return()=>window.removeEventListener("resize",fn);
  },[]);
  return w;
}
function useResponsive(){
  const w=useWindowSize();
  return{isMobile:w<768,isTablet:w>=768&&w<1200,isDesktop:w>=1200,w};
}


// Central fetch helper — injects token, auto-logouts on 401
let _logoutCallback = null;
function setLogoutCallback(fn){ _logoutCallback = fn; }
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("starmart_token");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem("starmart_token");
    if (_logoutCallback) _logoutCallback();
    throw new Error("Session expired. Please log in again.");
  }
  return res;
}
const CURRENCY = "KSh";

// ── Offline-aware error helper ────────────────────────────────────────────────
function getOfflineError(fallback = "Failed to load data.") {
  return navigator.onLine
    ? fallback
    : "📶 You're offline. This section will reload automatically when your connection is restored.";
}

const CAT_COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6"];
const PERMISSIONS = {
  cashier: {
    nav:["pos","inv"],pos:true,posDiscounts:false,posCustomerPick:true,
    inventory:true,inventoryView:true,inventoryAdd:false,inventoryEdit:false,
    inventoryDelete:false,inventoryBarcode:false,customers:false,reports:false,
    customersAdd:false,
    color:"#3b82f6",badge:"CASHIER",icon:"🏪",
  },
  manager: {
    nav:["pos","inv","cust","reports","refunds"],pos:true,posDiscounts:true,posCustomerPick:true,
    inventory:true,inventoryView:true,inventoryAdd:false,inventoryEdit:true,
    inventoryDelete:false,inventoryBarcode:true,customers:true,customersAdd:true,
    customersDelete:false,reports:true,reportsExport:false,
    color:"#a855f7",badge:"MANAGER",icon:"📊",
  },
  admin: {
    nav:["pos","inv","cust","reports","refunds","security","settings"],pos:true,posDiscounts:true,posCustomerPick:true,
    inventory:true,inventoryView:true,inventoryAdd:true,inventoryEdit:true,
    inventoryDelete:true,inventoryBarcode:true,customers:true,customersAdd:true,
    customersDelete:true,reports:true,reportsExport:true,
    color:"#f5a623",badge:"ADMIN",icon:"⚙️",
  },
};


const C={bg:"#0B0F19",sidebar:"#0D1117",card:"#111827",cardHover:"#161D2E",border:"#1F2937",border2:"#1F2937",text:"#F0F2F5",text2:"#B0BAC8",text3:"#7A8699",amber:"#F59E0B",amberDim:"#D97706",amberGlow:"rgba(245,158,11,0.12)",green:"#22C55E",greenGlow:"rgba(34,197,94,0.12)",red:"#EF4444",redGlow:"rgba(239,68,68,0.12)",blue:"#6366F1",blueGlow:"rgba(99,102,241,0.12)",purple:"#A78BFA",mono:"'DM Mono',monospace"};



const GlobalStyle = () => {
  useEffect(() => {
    // Viewport — critical for mobile rendering
    let vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.prepend(vp); }
    vp.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    // Theme color (mobile browser chrome)
    let tc = document.querySelector('meta[name="theme-color"]');
    if (!tc) { tc = document.createElement('meta'); tc.name = 'theme-color'; document.head.appendChild(tc); }
    tc.content = '#0B0F19';
    // PWA-style mobile web app meta
    let mwa = document.querySelector('meta[name="mobile-web-app-capable"]');
    if (!mwa) { mwa = document.createElement('meta'); mwa.name = 'mobile-web-app-capable'; mwa.content = 'yes'; document.head.appendChild(mwa); }
    let awas = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (!awas) { awas = document.createElement('meta'); awas.name = 'apple-mobile-web-app-status-bar-style'; awas.content = 'black-translucent'; document.head.appendChild(awas); }
    // Favicon — inline SVG as data URI
    // Use the STARMART brand icon PNG as favicon
    const link = document.querySelector("link[rel~='icon']") || document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = '/starmart_icon.png';
    document.head.appendChild(link);
    const appleLink = document.querySelector("link[rel='apple-touch-icon']") || document.createElement('link');
    appleLink.rel = 'apple-touch-icon';
    appleLink.href = '/starmart_icon.png';
    document.head.appendChild(appleLink);
    document.title = 'STARMART POS';
  }, []);
  return (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&family=Inter:wght@400;500;600;700;800;900&family=DM+Mono:ital,wght@0,400;0,500;1,400&display=swap');

    /* ── Reset ──────────────────────────────────────────────────────────────── */
    *{box-sizing:border-box;margin:0;padding:0;}
    body{
      background:#0B0F19;color:#F0F2F5;
      font-family:'Plus Jakarta Sans','Inter',sans-serif;
      overflow:hidden;
      -webkit-font-smoothing:antialiased;
      -moz-osx-font-smoothing:grayscale;
      font-size:16px;line-height:1.6;
      -webkit-text-size-adjust:100%;
      text-size-adjust:100%;
    }
    ::-webkit-scrollbar{width:4px;height:4px;}
    ::-webkit-scrollbar-track{background:#0f1420;}
    ::-webkit-scrollbar-thumb{background:#1F2937;border-radius:4px;}
    ::-webkit-scrollbar-thumb:hover{background:#374151;}
    input,select,textarea,button{font-family:'Plus Jakarta Sans','Inter',sans-serif;}
    input:-webkit-autofill{-webkit-box-shadow:0 0 0 1000px #111827 inset!important;-webkit-text-fill-color:#E5E7EB!important;}

    /* ── Animations ─────────────────────────────────────────────────────────── */
    @keyframes scaleIn{from{opacity:0;transform:scale(0.96);}to{opacity:1;transform:scale(1);}}
    @keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(-8px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
    @keyframes floatUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}
    @keyframes slideRight{from{opacity:0;transform:translateX(-20px);}to{opacity:1;transform:translateX(0);}}
    @keyframes slideUp{from{opacity:0;transform:translateY(100%);}to{opacity:1;transform:translateY(0);}}
    @keyframes scanline{0%{top:-4px;}100%{top:100%;}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(0.7);}}
    @keyframes gridMove{from{background-position:0 0;}to{background-position:40px 40px;}}
    @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
    @keyframes shake{0%,100%{transform:translateX(0);}20%{transform:translateX(-6px);}40%{transform:translateX(6px);}60%{transform:translateX(-4px);}80%{transform:translateX(4px);}}
    @keyframes cartBounce{0%{transform:scale(1);}30%{transform:scale(1.08);}100%{transform:scale(1);}}
    @keyframes slideInRight{from{opacity:0;transform:translateX(8px);}to{opacity:1;transform:translateX(0);}}
    .shake{animation:shake 0.4s ease;}

    /* ── Utility classes ─────────────────────────────────────────────────────── */
    .grid-bg{position:absolute;inset:0;background-image:linear-gradient(rgba(245,166,35,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(245,166,35,0.04) 1px,transparent 1px);background-size:40px 40px;animation:gridMove 8s linear infinite;}
    input[type="file"]{display:none;}
    .img-upload-label{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:18px;border:2px dashed #1F2937;border-radius:10px;cursor:pointer;transition:all 0.2s;color:#4B5563;font-size:12px;}
    .img-upload-label:hover{border-color:#6366F1;color:#6366F1;}
    .nav-item{transition:all 0.15s cubic-bezier(0.4,0,0.2,1);}
    .nav-item:hover{background:rgba(99,102,241,0.1)!important;color:#F0F2F5!important;}
    .pos-card{transition:transform 0.15s cubic-bezier(0.4,0,0.2,1),box-shadow 0.15s ease,border-color 0.15s ease;}
    .pos-card:hover{transform:translateY(-2px) scale(1.01);box-shadow:0 8px 24px rgba(0,0,0,0.35);}
    .pos-card:active{transform:scale(0.98);}
    .qty-btn{transition:all 0.1s ease;}
    .qty-btn:hover{background:#1F2937!important;border-color:#374151!important;}
    .qty-btn:active{transform:scale(0.92);}
    .pay-btn{transition:all 0.15s cubic-bezier(0.4,0,0.2,1);}
    .pay-btn:hover{filter:brightness(1.12);transform:translateY(-1px);}
    .pay-btn:active{transform:scale(0.98);}
    .cat-pill{transition:all 0.15s ease;}
    .cat-pill:hover{border-color:#6366F1!important;color:#E5E7EB!important;}
    .cart-add{animation:cartBounce 0.3s ease;}
    .cart-row{animation:slideInRight 0.2s ease both;}
    .card-hover{transition:all 0.2s cubic-bezier(0.4,0,0.2,1);}
    .card-hover:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,0.4)!important;border-color:#374151!important;}
    .btn-primary:hover{background:#4F46E5!important;box-shadow:0 4px 16px rgba(99,102,241,0.35)!important;}
    .btn-ghost:hover{background:#1F2937!important;border-color:#374151!important;color:#E5E7EB!important;}
    .btn-success:hover{box-shadow:0 4px 14px rgba(34,197,94,0.3)!important;}
    .btn-danger:hover{background:rgba(239,68,68,0.18)!important;}
    [style*="overflowY: auto"],[style*="overflow-y: auto"],[style*='overflowY:"auto"']{
      -webkit-overflow-scrolling:touch;
      overscroll-behavior:contain;
    }
    .r-main-content > div{scrollbar-gutter:stable;}
    /* Tables: horizontal scroll on small screens */
    .r-table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .r-table-wrap table{min-width:600px;}


    /* ── POS Typography ─────────────────────────────────────────────────────── */
    /* Product card */
    .r-card-name{
      font-size:16px;
      font-weight:700;
      line-height:1.3;
      letter-spacing:-0.01em;
      font-family:'Plus Jakarta Sans','Inter',sans-serif;
    }
    .r-card-price{
      font-size:22px;
      font-weight:700;
      font-family:'DM Mono',monospace;
      letter-spacing:-0.03em;
    }
    /* Cart panel */
    .r-cart-item-name{
      font-size:17px;
      font-weight:700;
      letter-spacing:-0.01em;
      font-family:'Plus Jakarta Sans','Inter',sans-serif;
      white-space:normal;
      word-break:break-word;
      line-height:1.3;
    }
    .r-cart-total-amt{
      font-size:30px;
      font-weight:800;
      font-family:'DM Mono',monospace;
      letter-spacing:-0.03em;
      color:#22c55e;
    }
    /* Payment modal */
    .r-pay-method-label{
      font-size:15px;
      font-weight:700;
    }
    /* Bottom nav labels */
    .r-bnav-label{
      font-size:11px;
      font-weight:700;
      letter-spacing:0.03em;
      font-family:'Plus Jakarta Sans','Inter',sans-serif;
    }

        /* ══════════════════════════════════════════════════════════════════════════
       RESPONSIVE LAYOUT
       Breakpoints:
         Desktop  ≥ 1200px  — full sidebar + cart panel side by side
         Tablet   768–1199px — collapsed icon sidebar, no cart panel (drawer)
         Mobile   < 768px   — no sidebar, bottom nav, cart FAB+drawer
         Small    < 480px   — tighter spacing, single-col grids
         XSmall   < 360px   — minimum viable layout
    ══════════════════════════════════════════════════════════════════════════ */

    /* ── Sidebar ───────────────────────────────────────────────────────────────── */
    .r-sidebar{width:220px;transition:width 0.25s ease;flex-shrink:0;overflow:hidden;}
    .r-sidebar-label{transition:opacity 0.2s,max-width 0.2s;white-space:nowrap;}
    .r-sidebar-logo-text{display:block;}

    /* ── Bottom nav (mobile) ────────────────────────────────────────────────── */
    .r-bnav{
      display:none;position:fixed;bottom:0;left:0;right:0;z-index:300;
      background:#0D1117;border-top:1px solid #1F2937;
      height:56px;
      align-items:stretch;
      justify-content:space-around;
      overflow-x:auto;
      overflow-y:hidden;
      scrollbar-width:none;
      -webkit-overflow-scrolling:touch;
      padding-bottom:env(safe-area-inset-bottom,0px);
    }
    .r-bnav::-webkit-scrollbar{display:none;}
    .r-bnav-btn{
      flex:1;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:2px;background:none;border:none;cursor:pointer;
      color:#7A8699;font-size:10px;font-weight:600;
      text-transform:uppercase;letter-spacing:0.03em;
      padding:3px 2px;
      -webkit-tap-highlight-color:transparent;
      transition:color 0.15s;
      position:relative;
      min-height:40px;
    }
    .r-bnav-btn.active{color:#F0F2F5!important;}
    .r-bnav-label{font-size:10px;font-weight:700;margin-top:1px;}
    .r-bnav-btn.active .r-bnav-label{color:#F59E0B!important;}
    .r-bnav-btn.active svg{stroke:#F59E0B!important;}
    .r-bnav-btn.active .r-bnav-dot{display:block!important;}
    .r-bnav-dot{
      display:none;width:18px;height:3px;border-radius:2px;
      background:#F59E0B;position:absolute;top:6px;
    }

    /* ── Cart FAB & Drawer ─────────────────────────────────────────────────── */
    .r-cart-drawer{display:none;}
    .r-cart-fab{
      display:none;
      position:fixed;
      bottom:64px;
      right:16px;
      z-index:250;
      width:56px;height:56px;
      border-radius:50%;border:none;cursor:pointer;
      background:linear-gradient(135deg,#6366F1,#4F46E5);
      color:#fff;font-size:24px;
      box-shadow:0 4px 20px rgba(99,102,241,0.55);
      align-items:center;justify-content:center;
    }
    .r-cart-badge{
      position:absolute;top:-2px;right:-2px;
      background:#EF4444;color:#fff;
      font-size:10px;font-weight:800;
      min-width:18px;height:18px;border-radius:9px;
      display:flex;align-items:center;justify-content:center;padding:0 3px;
      border:2px solid #0D1117;
    }
    .r-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:240;}

    /* ── Tablet 768–1199px ──────────────────────────────────────────────────── */
    @media(max-width:1199px){
      .r-sidebar{width:64px;}
      .r-sidebar-label{opacity:0;max-width:0;overflow:hidden;pointer-events:none;}
      .r-sidebar-logo-text{display:none!important;}
      .r-sidebar-nav-dot{display:none!important;}
      .r-sidebar-section-label{display:none!important;}
      .r-header-chip{display:none!important;}
      .r-header-loc-full{display:none!important;}
    }
    @media(min-width:768px) and (max-width:1199px){
      .r-grid-products{grid-template-columns:repeat(3,1fr)!important;}
      .r-grid-stats{grid-template-columns:repeat(2,1fr)!important;}
      .r-kpi-4{grid-template-columns:repeat(2,1fr)!important;}
    }

    /* ── Mobile < 768px ─────────────────────────────────────────────────────── */
    @media(max-width:767px){
      body{overflow:auto;}

      /* Layout skeleton */
      .r-sidebar{display:none!important;}
      .r-bnav{display:flex!important;}
      .r-main-area{padding-bottom:64px!important;}
      .r-main-content{padding-bottom:64px;}

      /* Cart */
      .r-cart-fab{display:flex!important;}
      .r-cart-desktop{display:none!important;}
      .r-cart-drawer{
        display:flex!important;
        flex-direction:column;
        position:fixed!important;
        bottom:56px!important;
        left:0!important;right:0!important;
        width:100%!important;
        z-index:245;
        background:#0D1117;
        border-radius:20px 20px 0 0;
        border-top:1px solid #1F2937;
        max-height:calc(92vh - 56px);
        overflow:hidden;
        transform:translateY(calc(100% + 56px));
        transition:transform 0.32s cubic-bezier(0.4,0,0.2,1);
        will-change:transform;
      }
      .r-cart-drawer.open{transform:translateY(0)!important;}
      .r-cart-drawer::before{
        content:'';display:block;width:36px;height:4px;
        background:#374151;border-radius:2px;
        margin:12px auto 4px;
        flex-shrink:0;
      }
      .r-overlay.open{display:block!important;}

      /* Header */
      .r-header{
        min-height:52px!important;height:auto!important;
        padding:0 12px!important;gap:8px!important;
      }
      .r-header-newstaff{display:none!important;}
      .r-header-clock{display:none!important;}
      .r-header-loc{display:none!important;}
      .r-header-chip{display:none!important;}
      .r-header-view-subtitle{display:none!important;}
      .r-header-subtitle{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
      .r-header-branch-label{max-width:140px!important;font-size:13px!important;}
      .r-branch-sel{max-width:130px!important;font-size:13px!important;padding:5px 10px!important;}

      /* Login */
      .r-login-left{display:none!important;}

      /* POS top bar */
      .r-pos-topbar{
        flex-wrap:wrap;
        padding:8px 10px!important;
        gap:6px!important;
      }
      .r-pos-scan{min-width:0;flex:1 1 120px!important;}
      .r-pos-search{min-width:0;flex:1 1 140px!important;}
      .r-pos-count{display:none!important;}

      /* Category pills */
      .r-cat-bar{
        flex-wrap:nowrap!important;overflow-x:auto;
        padding:0 10px 6px!important;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;
      }
      .r-cat-bar::-webkit-scrollbar{display:none;}

      /* Product grid — 2 columns on mobile */
      .r-grid-products{grid-template-columns:repeat(2,1fr)!important;gap:8px!important;}
      .r-grid-stats{grid-template-columns:repeat(2,1fr)!important;}
      .r-grid-auto{grid-template-columns:1fr!important;}
      .r-kpi-4{grid-template-columns:repeat(2,1fr)!important;}
      .r-grid-reports{grid-template-columns:1fr!important;}

      /* Product card */
      .r-card-img{height:90px!important;}
      .r-card-name{font-size:13px!important;}
      .r-card-price{font-size:17px!important;}
      .r-card-sku{font-size:11px!important;display:none!important;}

      /* Modal — slides up from bottom */
      .r-modal-inner{
        border-radius:20px 20px 0 0!important;
        max-width:100%!important;width:100%!important;
        position:fixed!important;bottom:0!important;left:0!important;right:0!important;
        max-height:92vh!important;margin:0!important;
        animation:slideUp 0.28s cubic-bezier(0.4,0,0.2,1) both!important;
        padding:20px 16px 28px!important;
        overflow-y:auto!important;
      }
      .r-modal-overlay{align-items:flex-end!important;padding:0!important;}

      /* Tables */
      .r-table-wrap{overflow-x:auto;}
      .r-col-hide-mobile{display:none!important;}

      /* Analytics */
      .r-analytics-grid{grid-template-columns:1fr!important;}

      /* Payment / delivery / forms */
      .r-pay-grid{grid-template-columns:1fr!important;}
      .r-delivery-row{flex-direction:column!important;}
      .r-delivery-row > input,.r-delivery-row > div{flex:none!important;width:100%!important;}
      .r-form-2col{grid-template-columns:1fr!important;}

      /* Inventory list cards — full width */
      .r-inv-card{flex-direction:column!important;}
      .r-inv-img{width:100%!important;height:160px!important;border-radius:10px 10px 0 0!important;}

      /* Settings sections */
      .r-settings-row{flex-direction:column!important;gap:8px!important;}
    }

    /* ── Small mobile ≤ 480px ──────────────────────────────────────────────── */
    @media(max-width:480px){
      .r-grid-products{grid-template-columns:repeat(2,1fr)!important;gap:6px!important;}
      .r-kpi-4{grid-template-columns:repeat(2,1fr)!important;}
      .r-modal-inner{padding:16px 14px 24px!important;}
      .r-header-branch-label{max-width:100px!important;font-size:12px!important;}
      .r-card-img{height:80px!important;}
      .r-card-name{font-size:12px!important;}
      .r-card-price{font-size:15px!important;}
    }

    /* ── XSmall ≤ 360px (Galaxy S8, iPhone SE) ────────────────────────────── */
    @media(max-width:360px){
      body{font-size:14px;}
      .r-grid-products{grid-template-columns:repeat(2,1fr)!important;gap:5px!important;}
      .r-modal-inner{padding:14px 12px 20px!important;}
      .r-bnav-label{display:none!important;}
      .r-bnav-btn{justify-content:center;}
      .r-bnav{height:48px!important;}
      .r-main-area{padding-bottom:56px!important;}
      .r-cart-fab{bottom:56px!important;width:48px!important;height:48px!important;}
    }

    /* ── Large screens ≥ 1400px ───────────────────────────────────────────── */
    @media(min-width:1400px){
      .r-grid-products{grid-template-columns:repeat(4,1fr)!important;}
      .r-kpi-4{grid-template-columns:repeat(4,1fr)!important;}
    }
    @media(min-width:640px){
      .r-kpi-4{grid-template-columns:repeat(4,1fr)!important;}
    }
    /* ── Print ────────────────────────────────────────────────────────────── */
    @media print{
      .r-sidebar,.r-bnav,.r-header,.r-cart-desktop{display:none!important;}
      body{overflow:visible;background:#fff;color:#000;}
    }
  `}</style>
  );
};

const ksh = (n) => `KSh ${Number(n).toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
// Display a branch as "Name · Location" or just "Name" if no location
const branchLabel = (b) => b ? (b.location ? `${b.name} · ${b.location}` : b.name) : "—";

// Normalize a product from the API to the shape the UI expects
const norm = (p) => ({
  ...p,
  cat:         p.category?.name || p.cat || "General",
  price:       parseFloat(p.price),
  stock:       parseInt(p.stock),          // branch stock (or global fallback)
  globalStock: parseInt(p.globalStock ?? p.stock),
  branchStock: (p.branchStock||[]).map(bs=>({...bs,branchId:+bs.branchId})), // normalise branchId to number
});

function printBarcode(product, qty = 1, sizeId = "60x40") {
  const SIZES = {
    "60x40":  { w:227, h:151, barcodeH:80,  fontSize:12 },
    "50x30":  { w:189, h:113, barcodeH:60,  fontSize:11 },
    "38x25":  { w:144, h:94,  barcodeH:48,  fontSize:10 },
    "100x50": { w:378, h:189, barcodeH:110, fontSize:14 },
  };
  const sz = SIZES[sizeId] || SIZES["60x40"];
  const barcodeValue = product.barcode || product.sku || "";
  const digits = barcodeValue.replace(/\D/g, "");
  let format = "CODE128";
  let displayValue = barcodeValue;
  if (digits.length === 13) { format = "EAN13"; displayValue = digits; }
  else if (digits.length === 8)  { format = "EAN8";  displayValue = digits; }
  else if (digits.length === 12) { format = "UPC";   displayValue = digits; }

  const w = window.open("", "_blank", "width=800,height=650");
  if (!w) { alert("Pop-up blocked — allow pop-ups for this site to print labels."); return; }

  w.document.write(`<!DOCTYPE html>
<html>
<head>
<title>Labels</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<script>
  var FMT="${format}", VAL="${displayValue}";
  var SZ=${JSON.stringify(sz)}, QTY=${qty};
  var PROD=${JSON.stringify({name:product.name,sku:product.sku||"",price:product.price,emoji:product.emoji||""})};
<\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#f8fafc;font-family:Arial,sans-serif;}
.toolbar{
  position:fixed;top:0;left:0;right:0;z-index:99;
  background:#1e293b;color:#fff;padding:10px 16px;
  display:flex;align-items:center;gap:12px;font-size:13px;
}
.toolbar input{width:60px;padding:5px 8px;border:1px solid #475569;
  border-radius:5px;background:#0f172a;color:#fff;font-size:13px;}
.btn{padding:7px 18px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px;}
.btn-update{background:#6366f1;color:#fff;}
.btn-print{background:#22c55e;color:#000;margin-left:auto;}
#wrap{padding:60px 16px 16px;display:flex;flex-wrap:wrap;gap:12px;}
.label{
  background:#fff;border:1px solid #e2e8f0;border-radius:8px;
  padding:12px 10px 8px;
  display:flex;flex-direction:column;align-items:center;
  box-shadow:0 1px 4px rgba(0,0,0,0.08);
}
.label svg{display:block;}
@media print{
  .toolbar{display:none!important;}
  body{background:#fff;}
  #wrap{padding:0;gap:4mm;}
  .label{border:0.5px solid #ccc;box-shadow:none;border-radius:2mm;padding:2mm;}
  @page{margin:3mm;size:auto;}
}
</style>
</head>
<body>
<div class="toolbar">
  <strong>🖨 Label Preview</strong>
  <label>Qty: <input id="qtyIn" type="number" min="1" max="500"/></label>
  <button class="btn btn-update" onclick="build()">Update</button>
  <button class="btn btn-print" onclick="window.print()">🖨 Print Labels</button>
</div>
<div id="wrap"></div>
<script>
function build(){
  var q=Math.max(1,Math.min(500,parseInt(document.getElementById('qtyIn').value)||1));
  var h='';
  for(var i=0;i<q;i++) h+='<div class="label"><svg id="bc'+i+'"></svg></div>';
  document.getElementById('wrap').innerHTML=h;
  setTimeout(function(){
    document.querySelectorAll('.label svg').forEach(function(el){
      try{
        JsBarcode(el,VAL,{
          format:FMT,
          width:2,
          height:SZ.barcodeH,
          displayValue:true,
          fontSize:SZ.fontSize,
          fontOptions:'bold',
          font:'monospace',
          textAlign:'center',
          textPosition:'bottom',
          textMargin:5,
          margin:8,
          background:'#ffffff',
          lineColor:'#000000',
        });
        el.style.maxWidth=(SZ.w-20)+'px';
        el.style.height='auto';
      }catch(e){
        try{JsBarcode(el,VAL,{format:'CODE128',width:2,height:SZ.barcodeH,displayValue:true});}
        catch(e2){el.outerHTML='<p style="color:red;font-size:10px">Barcode error</p>';}
      }
    });
  },120);
}
document.getElementById('qtyIn').value=QTY;
build();
<\/script>
</body>
</html>`);
  w.document.close();
}


const SHOP_DEFAULTS={name:"My Shop",address:"Nairobi, Kenya",email:"",phone:"",thankYou:"Thank you for your business! 🇰🇪",paybill:"",paybillAccount:"POS",till:"",pochiPhone:"",lowStockThreshold:5};
function getShopSettings(){ try{ return {...SHOP_DEFAULTS,...JSON.parse(localStorage.getItem("starmart_shop")||"{}")}; }catch{ return SHOP_DEFAULTS; } }
function saveShopSettings(s){ localStorage.setItem("starmart_shop",JSON.stringify(s)); }
// Fetch settings from DB and cache in localStorage so all roles see up-to-date config
async function syncShopSettings(){
  try{
    const token=localStorage.getItem("starmart_token");
    if(!token) return null;
    const r=await apiFetch("/api/settings");
    if(r.ok){
      const data=await r.json();
      // Only update if DB actually has meaningful settings (not empty {})
      if(data&&typeof data==="object"&&(data.paybill||data.till||data.name)){
        saveShopSettings(data);
        return data;
      }
    }
  }catch{}
  return null;
}

function printReceipt(order) {
  const shop=getShopSettings();
  const displayName = order.branchName || shop.name || "StarMart";
  const del = order.delivery||{};
  const isDelivery = !!(del.isDelivery);
  const deliveryFee = isDelivery ? (Number(del.fee)||0) : 0;
  const isPaidNow = order.method !== "Cash on Delivery";
  const rows=order.items.map(i=>`<tr><td>${i.emoji||""} ${i.name}</td><td style="text-align:center">x${i.qty}</td><td style="text-align:right">KSh ${(i.price*i.qty).toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>`).join("");
  const w=window.open("","_blank","width=420,height=600");
  if(w){w.document.write(`<!DOCTYPE html><html><head><title>Receipt</title><style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Courier New',monospace;font-size:12px;width:300px;margin:0 auto;padding:12px;}
    h1{font-size:18px;text-align:center;margin-bottom:2px;}
    .s{text-align:center;font-size:10px;color:#555;margin-bottom:8px;}
    hr{border:none;border-top:1px dashed #999;margin:8px 0;}
    table{width:100%;border-collapse:collapse;}
    td{padding:3px 2px;}
    .t{font-weight:700;font-size:14px;}
    .c{text-align:center;}
    .delivery-box{background:#f0fdf4;border:2px solid #16a34a;border-radius:6px;padding:10px;margin:8px 0;}
    .delivery-title{font-weight:800;font-size:14px;color:#15803d;text-align:center;letter-spacing:1px;margin-bottom:6px;}
    .delivery-row{font-size:11px;margin-bottom:3px;}
    .delivery-label{font-weight:700;}
    .cod-box{background:#fef9c3;border:3px solid #ca8a04;border-radius:6px;padding:10px;margin:10px 0;text-align:center;}
    .cod-title{font-weight:800;font-size:13px;color:#92400e;letter-spacing:1px;}
    .cod-amount{font-weight:800;font-size:22px;color:#92400e;margin:4px 0;}
    .paid-box{background:#f0fdf4;border:2px solid #16a34a;border-radius:6px;padding:8px;margin:8px 0;text-align:center;}
    .paid-title{font-weight:800;font-size:14px;color:#15803d;letter-spacing:2px;}
    @media print{@page{margin:2mm;size:80mm auto;}}
  </style></head><body>
  <h1>${displayName}</h1>
  <div class="s">${shop.address||""}${shop.phone?`<br>Tel: ${shop.phone}`:""}${shop.email?`<br>${shop.email}`:""}</div>
  <hr>
  <div class="s">${order.date}<br>Order ${order.id}</div>
  ${order.custName?`<div class="s" style="color:#22c55e;font-weight:700;margin-top:4px">👤 ${order.custName}</div>`:""}

  ${isDelivery?`
  <div class="delivery-box">
    <div class="delivery-title">🚚 DELIVERY ORDER</div>
    ${del.name?`<div class="delivery-row"><span class="delivery-label">Customer:</span> ${del.name}</div>`:""}
    ${del.phone?`<div class="delivery-row"><span class="delivery-label">Phone:</span> ${del.phone}</div>`:""}
    ${del.altPhone?`<div class="delivery-row"><span class="delivery-label">Alt Phone:</span> ${del.altPhone}</div>`:""}
    ${del.address?`<div class="delivery-row"><span class="delivery-label">Address:</span> ${del.address}</div>`:""}
    ${del.area?`<div class="delivery-row"><span class="delivery-label">Area:</span> ${del.area}</div>`:""}
    ${del.landmark?`<div class="delivery-row"><span class="delivery-label">Landmark:</span> ${del.landmark}</div>`:""}
    ${del.town?`<div class="delivery-row"><span class="delivery-label">Town:</span> ${del.town}</div>`:""}
    ${del.deliveryTime?`<div class="delivery-row"><span class="delivery-label">Expected:</span> ${del.deliveryTime}</div>`:""}
    ${del.notes?`<div class="delivery-row" style="color:#555"><span class="delivery-label">Note:</span> ${del.notes}</div>`:""}
  </div>`:""}

  <hr>
  <table>${rows}</table><hr>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">KSh ${order.subtotal.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>
    ${order.discount>0?`<tr><td>Discount</td><td style="text-align:right">-KSh ${order.discount.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>`:""}
    ${deliveryFee>0?`<tr><td>🚚 Delivery Fee</td><td style="text-align:right">KSh ${deliveryFee.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>`:""}
    <tr><td>VAT (16% incl.)</td><td style="text-align:right">KSh ${order.tax.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>
    <tr class="t"><td>TOTAL</td><td style="text-align:right">KSh ${order.total.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>
    <tr><td>Payment</td><td style="text-align:right">${order.method}</td></tr>
    ${order.method==="Cash"&&order.cash>0?`<tr><td>Cash</td><td style="text-align:right">KSh ${order.cash.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>`:""}
    ${order.method==="Cash"&&order.change>=0?`<tr><td>Change</td><td style="text-align:right">KSh ${order.change.toLocaleString("en-KE",{minimumFractionDigits:2})}</td></tr>`:""}
    ${order.pointsRedeemed>0?`<tr><td>Points Redeemed</td><td style="text-align:right">-${order.pointsRedeemed} pts</td></tr>`:""}
    ${order.pointsEarned>0?`<tr><td style="color:#22c55e">Points Earned</td><td style="text-align:right;color:#22c55e">+${order.pointsEarned} pts</td></tr>`:""}
  </table>

  ${isDelivery&&order.method==="Cash"?`
  <div class="cod-box">
    <div class="cod-title">💵 COLLECT ON DELIVERY</div>
    <div class="cod-amount">KSh ${order.total.toLocaleString("en-KE",{minimumFractionDigits:2})}</div>
    <div style="font-size:10px;color:#92400e">Rider must collect this exact amount</div>
  </div>`:""}

  ${isDelivery&&order.method!=="Cash"?`
  <div class="paid-box">
    <div class="paid-title">✅ PAID — ${order.method.toUpperCase()}</div>
    <div style="font-size:10px;color:#166534;margin-top:2px">No cash collection required</div>
  </div>`:""}

  <hr>
  <div class="c" style="font-size:10px;color:#555;margin-top:6px">${shop.thankYou||"Thank you for your business! 🇰🇪"}</div>
  ${order.orderNumber?`<div class="c" style="font-size:9px;color:#aaa;margin-top:4px">Ref: ${order.orderNumber}</div>`:""}
  </body></html>`);
  setTimeout(()=>w.print(),400);
  }
}



// Typography scale
const TS={
  pageTitle:   {fontSize:26,fontWeight:700,letterSpacing:"-0.03em",lineHeight:1.15},
  sectionTitle:{fontSize:18,fontWeight:600,letterSpacing:"-0.02em",lineHeight:1.3},
  cardTitle:   {fontSize:18,fontWeight:600,letterSpacing:"-0.01em",lineHeight:1.4},
  body:        {fontSize:17,fontWeight:400,lineHeight:1.65},
  medium:      {fontSize:17,fontWeight:500,lineHeight:1.5},
  label:       {fontSize:15,fontWeight:500,color:"#B0BAC8",letterSpacing:"0.01em"},
  meta:        {fontSize:14,fontWeight:400,color:"#7A8699",lineHeight:1.5},
  mono:        {fontFamily:"'DM Mono',monospace",fontWeight:500,letterSpacing:"-0.01em"},
  number:      {fontFamily:"'DM Mono',monospace",fontWeight:500,letterSpacing:"-0.02em"},
  bigNumber:   {fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:500,letterSpacing:"-0.03em"},
};

const CATS=["Electronics","Beauty","Food","Clothing","Sports","Home & Living","Other"];

const Tag=({children,color=C.blue})=><span style={{fontSize:14,fontWeight:600,letterSpacing:"0.04em",padding:"3px 10px",borderRadius:20,background:color+"18",color,display:"inline-flex",alignItems:"center"}}>{children}</span>;
const Divider=({margin="16px 0"})=><div style={{height:1,background:C.border,margin}}/>;
const Input=({style={},...p})=><input {...p} style={{background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"9px 12px",fontSize:17,fontWeight:400,outline:"none",width:"100%",transition:"all 0.15s",...style}} onFocus={e=>{e.target.style.borderColor=C.blue;e.target.style.boxShadow=`0 0 0 3px ${C.blueGlow}`;}} onBlur={e=>{e.target.style.borderColor=C.border;e.target.style.boxShadow="none";}}/>;
const Select=({children,style={},...p})=><select {...p} style={{background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"9px 12px",fontSize:17,outline:"none",transition:"all 0.15s",...style}}>{children}</select>;
const Btn=({children,variant="primary",style={},...p})=>{
  const base={border:"none",borderRadius:8,fontWeight:600,fontSize:16,letterSpacing:"-0.01em",padding:"9px 16px",cursor:"pointer",transition:"all 0.15s cubic-bezier(0.4,0,0.2,1)",display:"inline-flex",alignItems:"center",gap:6};
  const cls={primary:"btn-primary",ghost:"btn-ghost",success:"btn-success",danger:"btn-danger"};
  const v={
    primary:{background:C.blue,color:"#fff",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"},
    secondary:{background:C.border,color:C.text},
    ghost:{background:"transparent",color:C.text2,border:`1px solid ${C.border}`},
    danger:{background:C.redGlow,color:C.red,border:`1px solid ${C.red}33`},
    success:{background:C.greenGlow,color:C.green,border:`1px solid ${C.green}33`},
    amber:{background:C.amber,color:"#000",fontWeight:700},
  };
  return <button {...p} className={cls[variant]||""} style={{...base,...(v[variant]||v.primary),...style}}>{children}</button>;
};
const Card=({children,style={},onClick,hover=false})=><div onClick={onClick} className={hover?"card-hover":""} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,transition:"all 0.2s",...style}}>{children}</div>;
const Modal=({children,onClose,title,wide})=>(
  <div className="r-modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div className="r-modal-inner" style={{background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:wide?700:500,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.6)",animation:"scaleIn 0.18s ease both"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,paddingBottom:16,borderBottom:`1px solid ${C.border}`}}>
        <span style={{fontWeight:700,fontSize:20,letterSpacing:"-0.02em"}}>{title}</span>
        <button onClick={onClose} style={{background:"transparent",border:"none",color:C.text3,cursor:"pointer",fontSize:18,lineHeight:1,padding:"2px 6px",borderRadius:6,transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background=C.border;e.currentTarget.style.color=C.text;}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=C.text3;}}>✕</button>
      </div>
      {children}
    </div>
  </div>
);
const LockedBanner=({reason})=>(
  <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:40,textAlign:"center"}}>
    <div style={{width:64,height:64,borderRadius:16,background:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28}}>🔒</div>
    <div style={{fontWeight:700,fontSize:20,letterSpacing:"-0.02em"}}>Access Restricted</div>
    <div style={{color:C.text2,fontSize:16,maxWidth:320,lineHeight:1.75}}>{reason}</div>
  </div>
);


function BarcodeDisplay({value, width=240, height=85}){
  const svgRef = React.useRef(null);
  React.useEffect(()=>{
    if(!svgRef.current || !value) return;
    const barcodeH = Math.max(25, Math.round(height * 0.6));
    const fontSize  = Math.max(9, Math.round(barcodeH * 0.22));
    const doRender = () => {
      if(!window.JsBarcode) return;
      const digits = value.replace(/\D/g,"");
      let format = "CODE128";
      let renderValue = value;
      if(digits.length === 13){ format = "EAN13"; renderValue = digits; }
      else if(digits.length === 8){ format = "EAN8"; renderValue = digits; }
      else if(digits.length === 12){ format = "UPC"; renderValue = digits; }
      try {
        window.JsBarcode(svgRef.current, renderValue, {
          format,
          width:        Math.max(1.4, width / 150),
          height:       barcodeH,
          displayValue: true,
          fontSize,
          fontOptions:  "bold",
          font:         "monospace",
          textAlign:    "center",
          textPosition: "bottom",
          textMargin:   Math.max(3, Math.round(barcodeH * 0.08)),
          margin:       Math.max(6, Math.round(width * 0.04)),
          background:   "#ffffff",
          lineColor:    "#000000",
          flat:         false,
        });
      } catch(e) {
        try {
          window.JsBarcode(svgRef.current, value, {
            format: "CODE128", width: Math.max(1.4, width/150), height: barcodeH,
            displayValue: true, fontSize, fontOptions: "bold",
            font: "monospace", textMargin: 4, margin: 8, background: "#ffffff",
          });
        } catch(e2) { console.warn("Barcode render failed:", e2.message); }
      }
    };
    if(window.JsBarcode) doRender();
    else { const t = setTimeout(doRender, 150); return ()=>clearTimeout(t); }
  },[value, width, height]);

  return(
    <div style={{background:"#fff",padding:"6px 10px",borderRadius:8,display:"inline-flex",
      alignItems:"center",justifyContent:"center",border:"1px solid #e5e7eb",minWidth:160}}>
      <svg ref={svgRef}/>
    </div>
  );
}

/* ── IMAGE UPLOAD COMPONENT ── */
function ImageUpload({ value, onChange }) {
  const fileRef = useRef(null);
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert("Image must be under 2MB"); return; }
    const reader = new FileReader();
    reader.onloadend = () => onChange(reader.result);
    reader.readAsDataURL(file);
  };
  return (
    <div>
      <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:8}}>
        Product Image <span style={{color:C.text3,fontWeight:400,fontSize:10}}>(optional · max 2MB)</span>
      </label>
      {value ? (
        <div style={{position:"relative",display:"inline-block"}}>
          <img src={value} alt="preview" style={{width:120,height:120,objectFit:"cover",borderRadius:10,border:`2px solid ${C.amber}44`,display:"block"}}/>
          <button onClick={()=>onChange("")} style={{position:"absolute",top:-6,right:-6,width:22,height:22,borderRadius:"50%",background:C.red,border:"none",color:"#fff",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700}}>✕</button>
          <button onClick={()=>fileRef.current.click()} style={{marginTop:8,display:"block",width:120,padding:"5px 0",background:C.border,border:"none",borderRadius:6,color:C.text2,fontSize:13,cursor:"pointer"}}>Change Image</button>
        </div>
      ) : (
        <label className="img-upload-label" onClick={()=>fileRef.current.click()}>
          <span style={{fontSize:32}}>🖼️</span>
          <span style={{fontWeight:600}}>Click to upload image</span>
          <span style={{fontSize:10}}>JPG, PNG, WebP</span>
        </label>
      )}
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile}/>
    </div>
  );
}

/* ══════════ BRANCH STOCK EDITOR ══════════ */
function BranchStockEditor({product,branches,onClose}){
  const [stocks,setStocks]=useState(()=>{
    // Build map of branchId -> stock, using branchStock data where available
    // Always key by the branch's actual numeric id (from branches prop) to avoid NaN
    const bsMap={};
    (product.branchStock||[]).forEach(bs=>{ if(bs.branchId!=null) bsMap[+bs.branchId]=bs.stock; });
    // Seed every known branch with 0 if no BranchProduct row exists yet
    const map={};
    branches.forEach(b=>{ map[b.id] = bsMap[b.id] ?? 0; });
    return map;
  });
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [error,setError]=useState("");

  const handleSave=async()=>{
    setSaving(true);setError("");
    try{
      // Only save branches that have a valid numeric ID
      const entries=Object.entries(stocks).filter(([id])=>!isNaN(parseInt(id)));
      if(entries.length===0){ setError("No valid branch stock to save."); setSaving(false); return; }
      for(const [branchId,stock] of entries){
        const r=await apiFetch(`/api/branches/${parseInt(branchId)}/stock/${product.id}`,{
          method:"PUT",
          body:JSON.stringify({stock:parseInt(stock)||0}),
        });
        if(!r.ok){ const d=await r.json(); setError(d.error||"Save failed."); setSaving(false); return; }
      }
      setSaved(true);
      setTimeout(()=>{ setSaved(false); onClose(); },1500);
    }catch{setError(getOfflineError("Cannot connect to server.")); }
    setSaving(false);
  };

  const total=Object.values(stocks).reduce((s,v)=>s+(parseInt(v)||0),0);

  return(
    <Modal title={`Branch Stock — ${product.name}`} onClose={onClose}>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
        background:"rgba(255,255,255,0.03)",borderRadius:10,marginBottom:16}}>
        <div style={{width:40,height:40,borderRadius:9,overflow:"hidden",flexShrink:0,
          background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>
          {product.image?<img src={product.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:product.emoji||"📦"}
        </div>
        <div>
          <div style={{fontWeight:600,fontSize:15}}>{product.name}</div>
          <div style={{fontSize:15,color:C.text3}}>Global stock: <span style={{color:C.amber,fontFamily:"DM Mono,monospace"}}>{product.globalStock??product.stock}</span> units total</div>
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {branches.map(b=>(
          <div key={b.id} style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1,fontSize:15,fontWeight:500}}>{b.name}
              {b.location&&<span style={{fontSize:15,color:C.text3,marginLeft:6}}>{b.location}</span>}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <button onClick={()=>setStocks(s=>({...s,[b.id]:Math.max(0,(parseInt(s[b.id])||0)-1)}))}
                style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:16,fontWeight:600}}>−</button>
              <input
                type="number" min="0"
                value={stocks[b.id]??0}
                onChange={e=>setStocks(s=>({...s,[b.id]:Math.max(0,parseInt(e.target.value)||0)}))}
                style={{width:64,background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,
                  borderRadius:7,padding:"5px 8px",fontSize:16,fontFamily:"DM Mono,monospace",
                  textAlign:"center",outline:"none"}}
              />
              <button onClick={()=>setStocks(s=>({...s,[b.id]:(parseInt(s[b.id])||0)+1}))}
                style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:16,fontWeight:600}}>+</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        padding:"10px 14px",borderRadius:8,background:"rgba(255,255,255,0.03)",
        border:`1px solid ${C.border}`,marginBottom:14,fontSize:14}}>
        <span style={{color:C.text3}}>Branch total assigned</span>
        <span style={{fontFamily:"DM Mono,monospace",fontWeight:700,
          color:total>(product.globalStock??product.stock)?C.red:C.green}}>
          {total} / {product.globalStock??product.stock} units
        </span>
      </div>
      {total>(product.globalStock??product.stock)&&(
        <div style={{background:C.red+"12",border:`1px solid ${C.red}33`,borderRadius:8,
          padding:"8px 12px",fontSize:14,color:C.red,marginBottom:12}}>
          ⚠️ Branch assignments exceed global stock. The global stock will be used as the authoritative total.
        </div>
      )}
      {error&&<div style={{background:error.startsWith("📶")?C.amber:C.red+"15",border:`1px solid ${error.startsWith("📶")?C.amber:C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:error.startsWith("📶")?C.amber:C.red,marginBottom:12}}>{error}</div>}
      {saved&&<div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.green,marginBottom:12}}>✅ Branch stock saved!</div>}
      <div style={{display:"flex",gap:8}}>
        <Btn variant="ghost" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={saving} style={{flex:2,justifyContent:"center"}}>
          {saving?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Saving…</span>:"💾 Save Branch Stock"}
        </Btn>
      </div>
    </Modal>
  );
}

/* ── PRODUCT FORM (add / edit) ── */
function ProductForm({ initial, onSave, onClose, loading, error, isEdit }) {
  const STANDARD_CATS = ["Electronics","Beauty","Food","Clothing","Sports","Home & Living","Other"];
  const isCustomCat = initial?.cat && !STANDARD_CATS.includes(initial.cat);
  const [form, setForm] = useState({
    name: initial?.name || "",
    cat: isCustomCat ? "Other" : (initial?.cat || "Electronics"),
    customCat: isCustomCat ? (initial?.cat || "") : "",
    price: initial?.price || "",
    stock: initial?.stock || "",
    sku: initial?.sku || "",
    barcode: initial?.barcode || "",
    emoji: initial?.emoji || "📦",
    image: initial?.image || "",
  });
  const [skuManual, setSkuManual] = useState(!!initial?.sku); // if user typed SKU manually
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  // Auto-generate SKU from name when not editing and user hasn't typed one manually
  const autoSku = (name) => {
    if(!name.trim()) return "";
    const words = name.trim().toUpperCase().split(/\s+/);
    const prefix = words.length>=2
      ? words.slice(0,2).map(w=>w.slice(0,2)).join("")   // "Wireless Headphones" → "WIHE"
      : words[0].slice(0,4);                              // "Headphones" → "HEAD"
    const suffix = Math.floor(1000+Math.random()*9000);   // random 4-digit number
    return `${prefix}-${suffix}`;
  };

  const handleNameChange = (v) => {
    set("name", v);
    if(!isEdit && !skuManual) {
      set("sku", autoSku(v));
    }
  };

  const handleSkuChange = (v) => {
    set("sku", v);
    setSkuManual(v.trim().length > 0);
  };

  const resetSku = () => {
    const generated = autoSku(form.name);
    set("sku", generated);
    setSkuManual(false);
  };

  return (
    <div style={{display:"flex",gap:20}}>
      {/* LEFT: image */}
      <div style={{flexShrink:0,width:160}}>
        <ImageUpload value={form.image} onChange={v=>set("image",v)}/>
        <div style={{marginTop:16}}>
          <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Emoji Icon</label>
          <Input value={form.emoji} onChange={e=>set("emoji",e.target.value)} placeholder="📦" style={{textAlign:"center",fontSize:22}}/>
          <div style={{fontSize:14,color:C.text3,marginTop:4}}>Used as fallback if no image</div>
        </div>
      </div>
      {/* RIGHT: fields */}
      <div style={{flex:1,display:"flex",flexDirection:"column",gap:12}}>
        <div>
          <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Product Name *</label>
          <Input value={form.name} onChange={e=>handleNameChange(e.target.value)} placeholder="e.g. Wireless Headphones"/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Price (KSh) *</label>
            <Input type="number" value={form.price} onChange={e=>set("price",e.target.value)} placeholder="e.g. 4500"/>
          </div>
          <div>
            <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Stock Qty *</label>
            <Input type="number" value={form.stock} onChange={e=>set("stock",e.target.value)} placeholder="e.g. 20"/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase"}}>SKU</label>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {!skuManual&&!isEdit&&<span style={{fontSize:11,fontWeight:700,color:C.green,background:"rgba(34,197,94,0.12)",padding:"1px 7px",borderRadius:20,letterSpacing:"0.04em"}}>AUTO</span>}
                {skuManual&&!isEdit&&<button onClick={resetSku} style={{fontSize:11,color:C.blue,background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:600}}>↺ Reset</button>}
              </div>
            </div>
            <Input
              value={form.sku}
              onChange={e=>handleSkuChange(e.target.value)}
              placeholder="Auto-generated"
              style={{fontFamily:"'DM Mono',monospace",
                borderColor:skuManual?"":C.green+"66",
                background:skuManual?"":C.green+"06"}}/>
            {!isEdit&&<div style={{fontSize:12,color:C.text3,marginTop:3}}>
              {skuManual?"Custom SKU — must be unique":"Generated from product name · you can edit it"}
            </div>}
          </div>
          <div>
            <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Category *</label>
            <Select value={form.cat} onChange={e=>set("cat",e.target.value)} style={{width:"100%"}}>
              {CATS.map(c=><option key={c}>{c}</option>)}
            </Select>
            {form.cat==="Other"&&(
              <div style={{marginTop:8}}>
                <Input
                  value={form.customCat||""}
                  onChange={e=>set("customCat",e.target.value)}
                  placeholder="e.g. Stationery, Hardware, Jewellery…"
                  autoFocus
                  style={{borderColor:C.blue+"66",background:C.blue+"06"}}
                />
                <div style={{fontSize:12,color:C.text3,marginTop:4}}>
                  This will be saved as the product's category
                </div>
              </div>
            )}
          </div>
        </div>
        <div>
          <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>🔲 Barcode <span style={{color:C.text3,fontWeight:400,textTransform:"none",letterSpacing:0}}>(optional — leave blank to use SKU)</span></label>
          <Input value={form.barcode} onChange={e=>set("barcode",e.target.value)} placeholder="e.g. 6001234567890" style={{fontFamily:"DM Mono,monospace"}}/>
        </div>
        {error && <div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red}}>⚠️ {error}</div>}
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <Btn variant="ghost" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
          <Btn onClick={()=>onSave(form)} disabled={loading} style={{flex:2,justifyContent:"center"}}>
            {loading?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:14,height:14,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>{isEdit?"Saving…":"Adding…"}</span>:isEdit?"💾 Save Changes":"➕ Add Product"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ── AUTH HELPERS ── */
const PW_COLORS = ["#ef4444","#f97316","#eab308","#22c55e"];
const PW_LABELS = ["Weak","Fair","Good","Strong"];
const pwChecks = (p) => [p.length>=8, /[A-Z]/.test(p), /[0-9]/.test(p), /[^a-zA-Z0-9]/.test(p)];

/* ── AUTH SHARED COMPONENTS ── */
function SubmitBtn({ onClick, label, loadingLabel, loading }) {
  return (
    <button onClick={onClick} disabled={loading} style={{width:"100%",padding:13,background:C.amber,border:"none",borderRadius:10,color:"#000",fontWeight:700,fontSize:17,cursor:"pointer",opacity:loading?0.7:1,marginTop:4}}>
      {loading
        ? <span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}><span style={{width:16,height:16,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>{loadingLabel}</span>
        : label}
    </button>
  );
}

function PwStrength({ pass }) {
  const score = pwChecks(pass).filter(Boolean).length;
  return pass ? (
    <div style={{marginTop:6}}>
      <div style={{display:"flex",gap:3,marginBottom:4}}>{[0,1,2,3].map(i=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<score?PW_COLORS[score-1]:"#252a3a",transition:"all 0.3s"}}/>)}</div>
      <div style={{fontSize:15,fontWeight:600,color:score>0?PW_COLORS[score-1]:C.text3}}>{score>0?PW_LABELS[score-1]:""}</div>
    </div>
  ) : null;
}

function PasswordField({ label, value, onChange, show, onToggle, placeholder="Password", onKeyDown }) {
  return (
    <div>
      <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>{label}</label>
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>🔒</span>
        <Input type={show?"text":"password"} value={value} onChange={e=>onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} style={{paddingLeft:38,paddingRight:40}}/>
        <button onClick={onToggle} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:show?C.amber:C.text3,cursor:"pointer",fontSize:16,padding:0}}>{show?"🙈":"👁️"}</button>
      </div>
    </div>
  );
}

/* ══════════ LOGIN PAGE ══════════ */
function LoginPage({ onLogin }) {
  // mode: "checking" | "setup" | "login" | "2fa" | "signup" | "forgot" | "reset"
  const [mode, setMode] = useState("checking");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [shakeKey, setShakeKey] = useState(0);

  // setup fields
  const [setupName,  setSetupName]  = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPass,  setSetupPass]  = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupShowPass, setSetupShowPass] = useState(false);

  // login fields
  const [lEmail, setLEmail] = useState("");
  const [lPass,  setLPass]  = useState("");
  const [lShowPass, setLShowPass] = useState(false);

  // 2FA fields
  const [twoFaCode,     setTwoFaCode]     = useState("");
  const [twoFaToken,    setTwoFaToken]    = useState("");
  const [twoFaMasked,   setTwoFaMasked]   = useState("");
  const [twoFaDevCode,  setTwoFaDevCode]  = useState(""); // shown in dev when no email configured
  const [twoFaResent,   setTwoFaResent]   = useState(false);

  // signup fields
  const [sFirst,   setSFirst]   = useState("");
  const [sLast,    setSLast]    = useState("");
  const [sEmail,   setSEmail]   = useState("");
  const [sPass,    setSPass]    = useState("");
  const [sConfirm, setSConfirm] = useState("");
  const [sShowPass, setSShowPass] = useState(false);

  // forgot/reset fields
  const [fEmail,       setFEmail]       = useState("");
  const [resetMasked,  setResetMasked]  = useState(""); // masked email/phone shown after send
  const [resetDevCode, setResetDevCode] = useState(""); // code shown in dev mode
  const [resetEmailSent,  setResetEmailSent]  = useState(false);
  const [resetEmailError, setResetEmailError] = useState("");
  const [rCode,        setRCode]        = useState("");
  const [rPass,        setRPass]        = useState("");
  const [rConfirm,     setRConfirm]     = useState("");
  const [rShowPass,    setRShowPass]    = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState(false);

  const go   = (m) => { setMode(m); setError(""); setResetMasked(""); setResetDevCode(""); setResetSuccess(false); setTwoFaCode(""); setSignupSuccess(false); };
  const fail = (msg) => { setError(msg); setShakeKey(k=>k+1); };

  // ── Check setup status on mount ──
  useEffect(() => {
    fetch(`${API_URL}/api/auth/setup-status`)
      .then(r => r.json())
      .then(d => setMode(d.needsSetup ? "setup" : "login"))
      .catch(() => setMode("login")); // fallback to login on network error
  }, []);

  // ── Handlers ──
  const handleSetup = async () => {
    if (!setupName.trim())           return fail("Full name is required.");
    if (!setupEmail.includes("@"))   return fail("Enter a valid email address.");
    if (setupPass.length < 8)        return fail("Password must be at least 8 characters.");
    if (setupPass !== setupConfirm)  return fail("Passwords do not match.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: setupName, email: setupEmail, password: setupPass }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Setup failed."); }
      localStorage.setItem("starmart_token", data.token);
      onLogin({ ...data.user, perms: PERMISSIONS[data.user.role] });
    } catch(e) { fail("Cannot connect to server. Is the backend running?"); }
    setLoading(false);
  };

  const handleLogin = async () => {
    if (!lEmail.includes("@")) return fail("Enter a valid email.");
    if (lPass.length < 4)      return fail("Password too short.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: lEmail, password: lPass }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoading(false);
        // Show a clear pending message with different styling cue
        if (data.pending) return fail("⏳ " + (data.error || "Account pending admin approval."));
        return fail(data.error || "Invalid email or password.");
      }
      if (data.requires2FA) {
        setTwoFaToken(data.pendingToken);
        setTwoFaMasked(data.maskedEmail || data.maskedPhone || "");
        setTwoFaDevCode(data.devCode || "");
        setTwoFaResent(false);
        setLoading(false);
        go("2fa");
        return;
      }
      localStorage.setItem("starmart_token", data.token);
      onLogin({ ...data.user, perms: PERMISSIONS[data.user.role] });
    } catch(e) { fail("Cannot connect to server. Is the backend running?"); }
    setLoading(false);
  };

  const handleVerify2FA = async () => {
    if (twoFaCode.length !== 6) return fail("Enter the 6-digit code.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/verify-2fa`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: twoFaToken, code: twoFaCode }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Verification failed."); }
      localStorage.setItem("starmart_token", data.token);
      onLogin({ ...data.user, perms: PERMISSIONS[data.user.role] });
    } catch(e) { fail("Cannot connect to server."); }
    setLoading(false);
  };

  const handleSignup = async () => {
    if (!sFirst.trim())          return fail("First name is required.");
    if (!sEmail.includes("@"))   return fail("Enter a valid email.");
    if (sPass.length < 8)        return fail("Password must be at least 8 characters.");
    if (sPass !== sConfirm)      return fail("Passwords do not match.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/signup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name:`${sFirst.trim()} ${sLast.trim()}`, email:sEmail, password:sPass, role:"cashier" }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Signup failed."); }
      // Pending approval - show success message instead of logging in
      if (data.pending) {
        setLoading(false);
        go("login");
        setSignupSuccess(true);
        return;
      }
      localStorage.setItem("starmart_token", data.token);
      onLogin({ ...data.user, perms: PERMISSIONS[data.user.role] });
    } catch(e) { fail("Cannot connect to server."); }
    setLoading(false);
  };

  const handleResend2FA = async () => {
    setLoading(true); setError(""); setTwoFaResent(false);
    try {
      const res  = await fetch(`${API_URL}/api/auth/resend-2fa`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: twoFaToken }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Could not resend code."); }
      setTwoFaDevCode(data.devCode || "");
      setTwoFaResent(true);
      setTwoFaCode("");
    } catch(e) { fail("Cannot connect to server."); }
    setLoading(false);
  };

  const handleForgot = async () => {
    if (!fEmail.includes("@")) return fail("Enter a valid email address.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/forgot-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fEmail }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Something went wrong."); }
      setResetMasked(data.maskedEmail || data.maskedPhone || "");
      setResetDevCode(data.devCode || "");
      setResetEmailSent(data.emailSent || false);
      setResetEmailError(data.emailError || "");
      go("reset");
    } catch(e) {fail("Cannot connect to server."); }
    setLoading(false);
  };

  const handleReset = async () => {
    if (!rCode.trim())         return fail("Enter the 6-digit reset code.");
    if (rPass.length < 8)      return fail("Password must be at least 8 characters.");
    if (rPass !== rConfirm)    return fail("Passwords do not match.");
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${API_URL}/api/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email:fEmail, resetToken:rCode, newPassword:rPass }),
      });
      const data = await res.json();
      if (!res.ok) { setLoading(false); return fail(data.error || "Reset failed."); }
      setResetSuccess(true);
    } catch(e) { fail("Cannot connect to server."); }
    setLoading(false);
  };

  const isForgotFlow   = mode === "forgot" || mode === "reset";
  const is2FAMode      = mode === "2fa";
  const isSetupMode    = mode === "setup";
  const isCheckingMode = mode === "checking";

  return (
    <div style={{display:"flex",height:"100vh",width:"100vw",overflow:"hidden"}}>

      {/* ── LEFT PANEL ── */}
      <div className="r-login-left" style={{flex:"0 0 46%",background:C.sidebar,borderRight:`1px solid ${C.border}`,position:"relative",overflow:"hidden",display:"flex",flexDirection:"column",justifyContent:"space-between",padding:"48px 40px"}}>
        <div className="grid-bg"/>
        <div style={{position:"absolute",left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(245,166,35,0.4),transparent)",animation:"scanline 5s linear infinite",pointerEvents:"none",zIndex:1}}/>
        {[[0,0,"borderTop","borderLeft"],[0,1,"borderTop","borderRight"],[1,0,"borderBottom","borderLeft"],[1,1,"borderBottom","borderRight"]].map(([r,c,b1,b2],i)=>(
          <div key={i} style={{position:"absolute",top:r===0?16:"auto",bottom:r===1?16:"auto",left:c===0?16:"auto",right:c===1?16:"auto",width:24,height:24,[b1]:"2px solid rgba(245,166,35,0.4)",[b2]:"2px solid rgba(245,166,35,0.4)",zIndex:1}}/>
        ))}
        <div style={{position:"relative",zIndex:2,animation:"slideRight 0.6s ease both"}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:32}}>
            <img src="/starmart_icon.png" alt="STARMART"
              style={{width:80,height:80,borderRadius:22,objectFit:"cover",
                boxShadow:"0 8px 32px rgba(99,102,241,0.45)"}}/>
            <div>
              <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em"}}>STARMART</div>
              <div style={{fontSize:13,color:C.text3,letterSpacing:"0.1em",textTransform:"uppercase"}}>Point of Sale v2.0 · Nairobi</div>
            </div>
          </div>
          <div style={{fontWeight:800,fontSize:30,lineHeight:1.2,marginBottom:14,letterSpacing:"-0.03em"}}>
            {isSetupMode   && <>First Time<br/><span style={{color:C.amber}}>Setup</span></>}
            {isForgotFlow  && <>Recover Your<br/><span style={{color:C.amber}}>Account</span></>}
            {is2FAMode     && <>Two-Factor<br/><span style={{color:C.blue}}>Verification</span></>}
            {!isSetupMode&&!isForgotFlow&&!is2FAMode&&!isCheckingMode && <>Retail Intelligence<br/><span style={{color:C.amber}}>At Your Fingertips</span></>}
            {isCheckingMode && <>Loading<br/><span style={{color:C.amber}}>STARMART</span></>}
          </div>
          <div style={{fontSize:15,color:C.text2,lineHeight:1.7,maxWidth:320}}>
            {isSetupMode   && "No admin account exists yet. Create the owner account now — this screen appears only once."}
            {mode==="login"   && "Welcome back. Sign in with your registered email and password."}
            {mode==="signup"  && "Create a Cashier account. The store Admin can promote you to Manager or Admin later."}
            {mode==="forgot"  && "Enter your email address. A 6-digit reset code will be sent to your inbox."}
            {mode==="reset"   && "Enter the code sent to your email and choose a new password."}
            {mode==="2fa"     && "A 6-digit code was sent to your email address. Check your inbox and enter it below."}
          </div>
        </div>

        <div style={{position:"relative",zIndex:2}}>
          {isSetupMode ? (
            <div style={{background:"rgba(245,166,35,0.08)",border:"1px solid rgba(245,166,35,0.25)",borderRadius:12,padding:16}}>
              <div style={{fontWeight:700,fontSize:16,color:C.amber,marginBottom:10}}>🔐 Setup appears once</div>
              {["This screen only shows when no Admin exists","After setup it is permanently disabled","The Admin you create here can create Managers and other Admins from the dashboard","Staff members sign up as Cashiers from the normal Sign Up tab"].map((t,i)=>(
                <div key={i} style={{display:"flex",gap:8,marginBottom:7,fontSize:14,color:C.text2}}>
                  <span style={{color:C.amber,flexShrink:0}}>→</span>{t}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{fontSize:14,color:C.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite"}}/>Account Types
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[
                  {role:"Cashier",color:C.blue,icon:"🏪",note:"Self-register"},
                  {role:"Manager",color:C.purple,icon:"📊",note:"Admin creates"},
                  {role:"Admin",icon:"⚙️",color:C.amber,note:"Admin creates"},
                ].map(r=>(
                  <div key={r.role} style={{background:"rgba(20,23,31,0.8)",border:`1px solid ${r.color}33`,borderRadius:10,padding:10,textAlign:"center"}}>
                    <div style={{fontSize:22,marginBottom:4}}>{r.icon}</div>
                    <div style={{fontWeight:700,fontSize:16,color:r.color,marginBottom:3}}>{r.role}</div>
                    <div style={{fontSize:14,color:C.text3,background:r.color+"18",borderRadius:4,padding:"2px 6px",display:"inline-block"}}>{r.note}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:12,background:"rgba(245,166,35,0.07)",border:"1px solid rgba(245,166,35,0.2)",borderRadius:8,padding:"8px 12px",fontSize:15,color:C.text2,lineHeight:1.6}}>
                💡 New to STARMART? Create a <strong style={{color:C.amber}}>Cashier</strong> account. Ask your Admin to assign a higher role.
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",padding:24,overflowY:"auto",position:"relative",background:C.bg}}>
        <div style={{position:"absolute",top:"40%",left:"50%",transform:"translate(-50%,-50%)",width:440,height:440,background:"radial-gradient(circle,rgba(245,166,35,0.05) 0%,transparent 70%)",pointerEvents:"none"}}/>
        <div style={{width:"100%",maxWidth:420,position:"relative"}}>

          {/* Loading spinner */}
          {isCheckingMode && (
            <div style={{textAlign:"center",padding:60}}>
              <div style={{width:40,height:40,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite",marginBottom:16}}/>
              <div style={{color:C.text3,fontSize:14}}>Connecting to server…</div>
            </div>
          )}

          {/* Tab switcher — login / signup only */}
          {(mode==="login"||mode==="signup") && (
            <div style={{display:"flex",background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:12,padding:4,marginBottom:28,animation:"floatUp 0.4s ease both"}}>
              {["login","signup"].map(m=>(
                <button key={m} onClick={()=>go(m)} style={{flex:1,padding:"9px",borderRadius:8,border:"none",background:mode===m?C.amberGlow:"transparent",color:mode===m?C.amber:C.text3,fontWeight:700,fontSize:16,cursor:"pointer",transition:"all 0.2s"}}>
                  {m==="login"?"Sign In":"Create Account"}
                </button>
              ))}
            </div>
          )}

          {/* Back button — forgot/reset/2fa flow */}
          {(isForgotFlow||is2FAMode) && (
            <button onClick={()=>go("login")} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:C.text2,fontSize:15,cursor:"pointer",marginBottom:24,padding:0}}>
              ← Back to Sign In
            </button>
          )}

          <div key={mode} style={{animation:isCheckingMode?"none":"floatUp 0.35s ease both"}}>

            {/* ══ FIRST-TIME SETUP ══ */}
            {mode==="setup" && (
              <>
                <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,rgba(245,166,35,0.12),rgba(245,166,35,0.04))",border:`1.5px solid ${C.amber}44`,borderRadius:12,padding:"12px 16px",marginBottom:24}}>
                  <span style={{fontSize:28}}>🏗️</span>
                  <div>
                    <div style={{fontWeight:800,fontSize:18,color:C.amber}}>First-Time Setup</div>
                    <div style={{fontSize:14,color:C.text2}}>Create your Admin (owner) account to get started</div>
                  </div>
                </div>
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Full Name</label>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>👤</span>
                    <Input value={setupName} onChange={e=>setSetupName(e.target.value)} placeholder="Your full name" style={{paddingLeft:38}}/>
                  </div>
                </div>
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Email</label>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>✉️</span>
                    <Input type="email" value={setupEmail} onChange={e=>setSetupEmail(e.target.value)} placeholder="admin@yourstore.com" style={{paddingLeft:38}}/>
                  </div>
                </div>
                <div style={{marginBottom:8}}>
                  <PasswordField label="Password" value={setupPass} onChange={setSetupPass} show={setupShowPass} onToggle={()=>setSetupShowPass(s=>!s)} placeholder="Min. 8 characters"/>
                  <PwStrength pass={setupPass}/>
                </div>
                <div style={{marginBottom:18}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Confirm Password</label>
                  <Input type="password" value={setupConfirm} onChange={e=>setSetupConfirm(e.target.value)} placeholder="Re-enter password"/>
                  {setupConfirm&&<div style={{marginTop:5,fontSize:15,fontWeight:600,color:setupConfirm===setupPass?C.green:C.red}}>{setupConfirm===setupPass?"✓ Passwords match":"✗ Passwords don't match"}</div>}
                </div>
                {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                <SubmitBtn loading={loading} onClick={handleSetup} label="Create Admin Account & Enter Dashboard →" loadingLabel="Setting up…"/>
              </>
            )}

            {/* ══ LOGIN ══ */}
            {mode==="login" && (
              <>
                <div style={{marginBottom:24}}>
                  <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em",marginBottom:5}}>Welcome Back</div>
                  <div style={{color:C.text2,fontSize:15}}>Sign in with your registered email and password.</div>
                </div>
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Email</label>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>✉️</span>
                    <Input type="email" value={lEmail} onChange={e=>setLEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="you@starmart.co.ke" style={{paddingLeft:38}}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <PasswordField label="Password" value={lPass} onChange={setLPass} show={lShowPass} onToggle={()=>setLShowPass(s=>!s)} placeholder="Your password" onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
                </div>
                <div style={{display:"flex",justifyContent:"flex-end",marginBottom:20}}>
                  <button onClick={()=>go("forgot")} style={{background:"none",border:"none",color:C.amber,fontSize:15,cursor:"pointer",fontWeight:600}}>Forgot password?</button>
                </div>
                {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                {signupSuccess&&(
                  <div style={{background:"rgba(34,197,94,0.1)",border:`1px solid ${C.green}44`,borderRadius:8,
                    padding:"12px 14px",marginBottom:14,fontSize:14,color:C.green,lineHeight:1.5}}>
                    ✅ Account created! Your account is <strong>pending admin approval.</strong> You'll be able to log in once an admin approves it.
                  </div>
                )}
                <SubmitBtn loading={loading} onClick={handleLogin} label="Sign In to Dashboard →" loadingLabel="Signing in…"/>
              </>
            )}

            {/* ══ SIGNUP ══ */}
            {mode==="signup" && (
              <>
                <div style={{marginBottom:20}}>
                  <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em",marginBottom:5}}>Create Account</div>
                  <div style={{color:C.text2,fontSize:15}}>Registers as a <strong style={{color:C.amber}}>Cashier</strong>. Managers and Admins are created by an Admin inside the dashboard.</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                  {[["First Name",sFirst,setSFirst],["Last Name",sLast,setSLast]].map(([lbl,val,set])=>(
                    <div key={lbl}>
                      <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>{lbl}</label>
                      <Input value={val} onChange={e=>set(e.target.value)} placeholder={lbl.split(" ")[0]}/>
                    </div>
                  ))}
                </div>
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Work Email</label>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>✉️</span>
                    <Input type="email" value={sEmail} onChange={e=>setSEmail(e.target.value)} placeholder="you@starmart.co.ke" style={{paddingLeft:38}}/>
                  </div>
                </div>
                <div style={{marginBottom:8}}>
                  <PasswordField label="Password" value={sPass} onChange={setSPass} show={sShowPass} onToggle={()=>setSShowPass(s=>!s)} placeholder="Min. 8 characters"/>
                  <PwStrength pass={sPass}/>
                </div>
                <div style={{marginBottom:18}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Confirm Password</label>
                  <Input type="password" value={sConfirm} onChange={e=>setSConfirm(e.target.value)} placeholder="Re-enter password"/>
                  {sConfirm&&<div style={{marginTop:5,fontSize:15,fontWeight:600,color:sConfirm===sPass?C.green:C.red}}>{sConfirm===sPass?"✓ Passwords match":"✗ Passwords don't match"}</div>}
                </div>
                {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                <SubmitBtn loading={loading} onClick={handleSignup} label="Create Cashier Account →" loadingLabel="Creating account…"/>
              </>
            )}

            {/* ══ FORGOT PASSWORD ══ */}
            {mode==="forgot" && (
              <>
                <div style={{marginBottom:24}}>
                  <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em",marginBottom:5}}>Reset Password</div>
                  <div style={{color:C.text2,fontSize:15,lineHeight:1.6}}>Enter your registered email. A 6-digit code will be sent to your linked phone number via SMS.</div>
                </div>
                <div style={{marginBottom:18}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Registered Email</label>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:17}}>✉️</span>
                    <Input type="email" value={fEmail} onChange={e=>setFEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleForgot()} placeholder="you@starmart.co.ke" style={{paddingLeft:38}}/>
                  </div>
                </div>
                {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                <SubmitBtn loading={loading} onClick={handleForgot} label="Send Reset Code via Email →" loadingLabel="Sending email…"/>
              </>
            )}

            {/* ══ RESET PASSWORD ══ */}
            {mode==="reset" && (
              <>
                <div style={{marginBottom:20}}>
                  <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em",marginBottom:5}}>Set New Password</div>
                  {resetEmailSent&&resetMasked&&<div style={{display:"flex",alignItems:"center",gap:8,background:"rgba(34,197,94,0.08)",border:`1px solid ${C.green}33`,borderRadius:10,padding:"10px 14px",marginTop:8}}>
                    <span style={{fontSize:18}}>📧</span>
                    <div><div style={{fontSize:14,fontWeight:600,color:C.green}}>Code sent to {resetMasked}</div><div style={{fontSize:13,color:C.text3}}>Check your inbox (and spam folder)</div></div>
                  </div>}
                  {resetEmailError&&<div style={{display:"flex",flexDirection:"column",gap:6,background:"rgba(239,68,68,0.08)",border:`1px solid ${C.red}44`,borderRadius:10,padding:"10px 14px",marginTop:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>⚠️</span><div style={{fontSize:13,fontWeight:700,color:C.red}}>Email delivery failed</div></div>
                    <div style={{fontSize:12,color:C.text3,paddingLeft:24}}>{resetEmailError}</div>
                    {(resetEmailError.includes("domain")||resetEmailError.includes("verified")||resetEmailError.includes("only send"))&&<div style={{fontSize:12,color:C.amber,paddingLeft:24}}>{"💡 Go to resend.com > Domains and add your domain to send to any email address."}</div>}
                  </div>}
                  {resetDevCode&&<div style={{display:"flex",flexDirection:"column",gap:4,background:"rgba(245,158,11,0.12)",border:`2px solid ${C.amber}66`,borderRadius:10,padding:"12px 14px",marginTop:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:18}}>🔑</span><div style={{fontSize:13,fontWeight:700,color:C.amber}}>{resetEmailSent?"Backup code (email also sent)":"Use this code below — valid 15 min"}</div></div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:32,fontWeight:900,color:C.amber,letterSpacing:"0.25em",textAlign:"center",padding:"8px 0"}}>{resetDevCode}</div>
                    <div style={{fontSize:12,color:C.text3,textAlign:"center"}}>Enter this code in the field below</div>
                  </div>}
                </div>
                {resetSuccess ? (
                  <div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:12,padding:24,textAlign:"center"}}>
                    <div style={{fontSize:40,marginBottom:12}}>✅</div>
                    <div style={{fontWeight:800,fontSize:18,color:C.green,marginBottom:8}}>Password Reset!</div>
                    <div style={{fontSize:15,color:C.text2,marginBottom:20}}>You can now sign in with your new password.</div>
                    <button onClick={()=>go("login")} style={{padding:"10px 28px",background:C.green,border:"none",borderRadius:8,color:"#000",fontWeight:700,cursor:"pointer",fontSize:16}}>Go to Sign In</button>
                  </div>
                ) : (
                  <>
                    <div style={{marginBottom:12}}>
                      <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>6-Digit Verification Code</label>
                      <Input value={rCode} onChange={e=>setRCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="_ _ _ _ _ _" style={{fontFamily:"'DM Mono',monospace",fontSize:28,letterSpacing:"0.3em",textAlign:"center"}}/>
                    </div>
                    <div style={{marginBottom:8}}>
                      <PasswordField label="New Password" value={rPass} onChange={setRPass} show={rShowPass} onToggle={()=>setRShowPass(s=>!s)} placeholder="Min. 8 characters"/>
                    </div>
                    <div style={{marginBottom:18}}>
                      <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Confirm New Password</label>
                      <Input type="password" value={rConfirm} onChange={e=>setRConfirm(e.target.value)} placeholder="Re-enter new password"/>
                      {rConfirm&&<div style={{marginTop:5,fontSize:15,fontWeight:600,color:rConfirm===rPass?C.green:C.red}}>{rConfirm===rPass?"✓ Passwords match":"✗ Passwords don't match"}</div>}
                    </div>
                    {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                    <SubmitBtn loading={loading} onClick={handleReset} label="Reset Password →" loadingLabel="Resetting…"/>
                    <button onClick={()=>go("forgot")} style={{width:"100%",marginTop:10,padding:"9px",background:"none",border:`1px solid ${C.border}`,borderRadius:10,color:C.text2,fontSize:15,cursor:"pointer"}}>Resend code</button>
                  </>
                )}
              </>
            )}

            {/* ══ 2FA VERIFICATION ══ */}
            {mode==="2fa" && (
              <>
                <div style={{marginBottom:16}}>
                  <div style={{fontWeight:800,fontSize:24,letterSpacing:"-0.03em",marginBottom:5}}>Verify Your Identity</div>
                  {twoFaMasked&&<div style={{display:"flex",alignItems:"center",gap:10,background:`${C.blueGlow}`,border:`1px solid ${C.blue}33`,borderRadius:10,padding:"12px 14px",marginTop:10}}>
                    <span style={{fontSize:24}}>📧</span>
                    <div>
                      <div style={{fontSize:15,fontWeight:600,color:"#818CF8"}}>{twoFaResent?"New code sent!":"Code sent to your email"}</div>
                      <div style={{fontSize:14,color:C.text3}}>Sent to {twoFaMasked} · Valid for 10 minutes</div>
                    </div>
                  </div>}
                </div>

                {/* Dev mode banner — shown when AT_API_KEY not configured */}
                {twoFaDevCode&&<div style={{background:"rgba(245,158,11,0.1)",border:`1px solid ${C.amber}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:18}}>🛠️</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:C.amber,marginBottom:2}}>DEV MODE — Email not configured</div>
                    <div style={{fontSize:13,color:C.text3}}>Your code: <span style={{fontFamily:"'DM Mono',monospace",fontSize:17,fontWeight:700,color:C.amber,letterSpacing:"0.15em"}}>{twoFaDevCode}</span></div>
                  </div>
                </div>}

                <div style={{marginBottom:14}}>
                  <label style={{fontSize:14,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:8}}>6-Digit Verification Code</label>
                  <Input
                    value={twoFaCode}
                    onChange={e=>setTwoFaCode(e.target.value.replace(/\D/g,"").slice(0,6))}
                    onKeyDown={e=>e.key==="Enter"&&handleVerify2FA()}
                    placeholder="_ _ _ _ _ _"
                    autoFocus
                    style={{fontFamily:"'DM Mono',monospace",fontSize:32,letterSpacing:"0.35em",textAlign:"center",padding:"14px"}}
                  />
                </div>
                {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:15,color:C.red}}>⚠️ {error}</div>}
                <SubmitBtn loading={loading} onClick={handleVerify2FA} label="Verify & Sign In →" loadingLabel="Verifying…"/>
                <button onClick={handleResend2FA} disabled={loading} style={{width:"100%",marginTop:10,padding:"9px",background:"none",border:`1px solid ${C.border}`,borderRadius:10,color:C.text2,fontSize:15,cursor:"pointer",opacity:loading?0.5:1}}>
                  📨 Didn't receive the code? Resend
                </button>
                <button onClick={()=>go("login")} style={{width:"100%",marginTop:8,padding:"9px",background:"none",border:"none",color:C.text3,fontSize:14,cursor:"pointer"}}>
                  ← Back to login
                </button>
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

const ALL_NAV=[
  {id:"pos",     icon:"M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z",  label:"POS"},
  {id:"inv",     icon:"M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",                                                                    label:"Stock"},
  {id:"cust",    icon:"M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",                     label:"Customers"},
  {id:"reports", icon:"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z", label:"Stats"},
  {id:"refunds", icon:"M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6",                                                                                            label:"Refunds"},
  {id:"security",icon:"M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z", label:"Security"},
  {id:"settings",icon:"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z", label:"Settings"},
];
const NavIcon=({path,size=18,color="currentColor"})=>(<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={path}/></svg>);
function Sidebar({view,setView,user,onLogout,pendingCount=0}){
  const nav=ALL_NAV.filter(n=>user.perms.nav.includes(n.id));
  const rc=user.perms.color;
  return(
    <aside className="r-sidebar" style={{width:220,background:C.sidebar,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",padding:"0",gap:0,flexShrink:0,overflow:"hidden"}}>
      {/* Logo */}
      <div style={{padding:"18px 16px 14px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {/* Brand logo */}
          <img src="/starmart_icon.png" alt="STARMART"
            style={{width:56,height:56,borderRadius:16,flexShrink:0,
              objectFit:"cover",
              boxShadow:"0 6px 20px rgba(99,102,241,0.5)"}}/>
          <div>
            <div className="r-sidebar-logo-text" style={{fontWeight:900,fontSize:18,letterSpacing:"-0.04em",lineHeight:1.15,
              background:"linear-gradient(135deg,#E5E7EB,#A78BFA)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
              STARMART
            </div>
            <div className="r-sidebar-logo-text" style={{fontSize:13,color:C.text3,fontWeight:500,letterSpacing:"0.02em"}}>Point of Sale v2.0</div>
          </div>
        </div>
      </div>
      {/* Nav */}
      <nav style={{flex:1,overflowY:"auto",padding:"12px 10px"}}>
        <div className="r-sidebar-section-label" style={{fontSize:14,fontWeight:600,color:C.text3,letterSpacing:"0.1em",textTransform:"uppercase",padding:"4px 10px 10px"}}>Navigation</div>
        {nav.map(n=>{
          const active=view===n.id;
          return(<button key={n.id} onClick={()=>setView(n.id)} className={active?"":"nav-item"}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",cursor:"pointer",transition:"all 0.15s",marginBottom:2,textAlign:"left",
              background:active?"rgba(99,102,241,0.18)":"transparent",
              color:active?"#F0F2F5":C.text2}}>
            <div style={{width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
              background:active?"rgba(99,102,241,0.25)":"transparent",
              color:active?"#818CF8":C.text3,transition:"all 0.15s"}}>
              <NavIcon path={n.icon} size={16} color="currentColor"/>
            </div>
            <span className="r-sidebar-label" style={{fontSize:16,fontWeight:active?700:500,letterSpacing:"-0.01em",transition:"all 0.15s",color:active?"#F0F2F5":C.text2}}>{n.label}</span>
            {n.id==="security"&&pendingCount>0&&(
              <span style={{marginLeft:"auto",background:C.amber,color:"#000",fontSize:11,fontWeight:800,
                padding:"1px 7px",borderRadius:20,flexShrink:0,animation:"pulse 2s infinite"}}>
                {pendingCount}
              </span>
            )}
            {active&&<div className="r-sidebar-nav-dot" style={{marginLeft:"auto",width:3,height:16,borderRadius:2,background:"#818CF8"}}/>}
          </button>);
        })}
      </nav>
      {/* User footer */}
      <div style={{padding:"12px 10px",borderTop:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,marginBottom:6}}>
          <div style={{width:32,height:32,borderRadius:8,background:rc,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:16,color:"#000",flexShrink:0}}>{user.name[0].toUpperCase()}</div>
          <div style={{flex:1,minWidth:0}}>
            <div className="r-sidebar-label" style={{fontSize:15,fontWeight:600,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{user.name}</div>
            <div className="r-sidebar-label" style={{fontSize:13,color:rc,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>{user.role.toUpperCase()}</div>
          </div>
        </div>
        <button onClick={onLogout} className="btn-ghost" style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,cursor:"pointer",color:C.text3,fontSize:14,fontWeight:500,transition:"all 0.15s"}}
          onMouseEnter={e=>{e.currentTarget.style.background=C.redGlow;e.currentTarget.style.borderColor=C.red+"44";e.currentTarget.style.color=C.red;}}
          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text3;}}>
          <NavIcon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" size={14} color="currentColor"/>
          Sign Out
        </button>
      </div>
    </aside>
  );
}

/* Shared waiting UI for C2B (Paybill + Till) */
function C2BWaiting({stage,total,onCancel}){
  if(stage==="confirmed") return(
    <div style={{textAlign:"center",padding:"12px 0"}}>
      <div style={{fontSize:40,marginBottom:6}}>✅</div>
      <div style={{fontWeight:700,fontSize:16,color:C.green}}>Payment Received!</div>
      <div style={{color:C.text2,fontSize:14,marginTop:4}}>Saving order…</div>
    </div>
  );
  return(
    <div style={{textAlign:"center",padding:"12px 0"}}>
      <div style={{fontSize:36,marginBottom:8}}>📡</div>
      <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>Waiting for M-Pesa payment…</div>
      <div style={{color:C.text2,fontSize:15,marginBottom:12}}>Customer pays <strong style={{color:C.amber,fontFamily:"DM Mono,monospace"}}>{ksh(total)}</strong> from their phone — system auto-confirms on receipt.</div>
      <div style={{background:C.card,border:`1px solid ${C.green}33`,borderRadius:10,padding:"8px 14px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
        <div style={{display:"flex",gap:4}}>
          {[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:C.green,animation:`pulse 1.2s ease ${i*0.4}s infinite`}}/>)}
        </div>
        <span style={{fontSize:13,color:C.green,fontWeight:600}}>LISTENING FOR PAYMENT</span>
      </div>
      <button onClick={onCancel} style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:13,textDecoration:"underline"}}>Cancel</button>
    </div>
  );
}

/* ══════════ POS VIEW ══════════ */
// ── CustomerSearchPicker — fast type-to-search customer linker for POS ────────
function CustomerSearchPicker({customers, onSelect, onAddNew}){
  const [query,setQuery]=useState("");
  const [open,setOpen]=useState(false);
  const inputRef=useRef(null);

  const results=query.trim().length>0
    ? customers.filter(c=>
        c.name.toLowerCase().includes(query.toLowerCase())||
        (c.phone||"").includes(query)||
        (c.email||"").toLowerCase().includes(query.toLowerCase())
      ).slice(0,6)
    : [];

  const getTier=(spent)=>{
    const s=parseFloat(spent||0);
    if(s>=100000) return{label:"VIP",color:"#f59e0b",icon:"👑"};
    if(s>=20000)  return{label:"Gold",color:"#eab308",icon:"🥇"};
    if(s>=5000)   return{label:"Silver",color:"#94a3b8",icon:"🥈"};
    return               {label:"Regular",color:C.text3,icon:"👤"};
  };

  const handleSelect=(c)=>{
    onSelect(c);
    setQuery("");
    setOpen(false);
  };

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.amber} strokeWidth={2.5}>
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
        <span style={{fontSize:15,fontWeight:600,color:C.amber}}>Link customer for loyalty points</span>
      </div>

      {/* Search input */}
      <div style={{position:"relative"}}>
        <div style={{position:"relative"}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",
            fontSize:16,pointerEvents:"none"}}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e=>{setQuery(e.target.value);setOpen(true);}}
            onFocus={e=>{setOpen(true);e.target.style.borderColor=C.amber;}}
            onBlur={e=>{setTimeout(()=>setOpen(false),180);e.target.style.borderColor=C.amber+"33";}}
            placeholder="Search by name or phone…"
            style={{width:"100%",background:"#0D1117",border:`2px solid ${C.amber}33`,
              color:C.text,borderRadius:8,padding:"9px 12px 9px 32px",fontSize:16,
              outline:"none",transition:"border-color 0.15s",boxSizing:"border-box"}}
          />
        </div>

        {/* Dropdown results */}
        {open&&(results.length>0||onAddNew)&&(
          <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:500,marginTop:4,
            background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:10,
            boxShadow:"0 8px 32px rgba(0,0,0,0.6)",overflow:"hidden"}}>
            {results.map(c=>{
              const tier=getTier(c.totalSpent);
              return(
                <div key={c.id}
                  onMouseDown={()=>handleSelect(c)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                    cursor:"pointer",borderBottom:`1px solid ${C.border}`,transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="rgba(99,102,241,0.08)"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{width:34,height:34,borderRadius:10,flexShrink:0,
                    background:`${tier.color}22`,border:`1px solid ${tier.color}44`,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontWeight:800,fontSize:16,color:tier.color}}>
                    {c.name[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:16,letterSpacing:"-0.01em"}}>{c.name}</div>
                    <div style={{fontSize:14,color:C.text3}}>
                      {c.phone||"No phone"}
                      <span style={{marginLeft:8,color:tier.color,fontWeight:600}}>
                        {tier.icon} {tier.label}
                      </span>
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:15,fontWeight:700,color:C.green}}>⭐ {(c.points||0).toLocaleString()}</div>
                    <div style={{fontSize:13,color:C.text3}}>pts</div>
                  </div>
                </div>
              );
            })}

            {/* No results + add new */}
            {results.length===0&&query.trim()&&(
              <div style={{padding:"12px 14px",fontSize:15,color:C.text3,textAlign:"center"}}>
                No customer found for "{query}"
              </div>
            )}
            {onAddNew&&(
              <div onMouseDown={onAddNew}
                style={{padding:"10px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,
                  borderTop:results.length>0?`1px solid ${C.border}`:"none",color:C.blue,fontWeight:600,fontSize:15,
                  transition:"background 0.1s"}}
                onMouseEnter={e=>e.currentTarget.style.background="rgba(99,102,241,0.08)"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span style={{fontSize:18}}>＋</span> Add new customer
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{fontSize:14,color:C.text3,marginTop:5}}>
        💡 No customer? That's fine — this sale won't earn loyalty points
      </div>
    </div>
  );
}


function POSView({products,setProducts,perms,cart,setCart,selCust,setSelCust,discountValue,setDiscountValue,activeBranch,branches=[],shopSettings:shopSettingsProp,onQueueAdd,delivery,setDelivery}){
  const {isMobile}=useResponsive();
  const LST=parseInt((shopSettingsProp||getShopSettings()).lowStockThreshold)||5; // low stock threshold
  const [cartOpen,setCartOpen]=useState(false);
  const [posCustomers,setPosCustomers]=useState([]);
  const refreshPosCustomers=()=>{
    if(!perms.posCustomerPick) return;
    apiFetch("/api/customers").then(r=>r.json()).then(data=>{ if(Array.isArray(data)) setPosCustomers(data); }).catch(()=>{});
  };
  useEffect(()=>{ refreshPosCustomers(); },[perms.posCustomerPick]);
  const [posAddCustModal,setPosAddCustModal]=useState(false);
  const [posNewCustForm,setPosNewCustForm]=useState({name:"",phone:"",email:""});
  const [posNewCustSaving,setPosNewCustSaving]=useState(false);
  const [posAddCustError,setPosAddCustError]=useState("");
  const [pointsRedeemed,setPointsRedeemed]=useState(0); // how many points customer is redeeming this sale
  const POINTS_TO_KSH = 1; // 1 point = KSh 1 discount
  const addCustFromPOS=async()=>{
    if(!posNewCustForm.name.trim()) return;
    setPosNewCustSaving(true);
    setPosAddCustError("");
    try{
      const posPayload={
        name: posNewCustForm.name.trim(),
        ...(posNewCustForm.phone?.trim() ? {phone: posNewCustForm.phone.trim()} : {}),
        ...(posNewCustForm.email?.trim() ? {email: posNewCustForm.email.trim()} : {}),
      };
      const r=await apiFetch("/api/customers",{method:"POST",body:JSON.stringify(posPayload)});
      const d=await r.json();
      if(!r.ok){
        setPosAddCustError(d.error||"Failed to add customer.");
        setPosNewCustSaving(false);
        return;
      }
      // Refresh customer list then select the new customer
      apiFetch("/api/customers").then(res=>res.json()).then(data=>{
        if(Array.isArray(data)) setPosCustomers(data);
      }).catch(()=>{});
      // d is the newly created customer — set it directly
      setSelCust({...d, points: d.points||0});
      setPosAddCustModal(false);
      setPosNewCustForm({name:"",phone:"",email:""});
      setPosAddCustError("");
    }catch(e){
      setPosAddCustError("Cannot connect to server.");
    }
    setPosNewCustSaving(false);
  };
  const [search,setSearch]=useState("");const [cat,setCat]=useState("All");const [payModal,setPayModal]=useState(false);
  // Auto-fill M-Pesa phone from selected customer
  const openPayModal=()=>{
    if(selCust?.phone&&!mpesaPhone){
      const p=selCust.phone.replace(/\s/g,"").replace(/^\+/,"");
      const formatted=p.startsWith("0")?"254"+p.slice(1):p;
      setMpesaPhone(formatted);
    }
    setPayModal(true);
  };const [receiptModal,setReceiptModal]=useState(null);const [cashInput,setCashInput]=useState("");const [payMethod,setPayMethod]=useState("Cash");const [scanFlash,setScanFlash]=useState(null);const [manualBarcode,setManualBarcode]=useState("");
  const scanBuffer=useRef("");const scanTimer=useRef(null);const manualRef=useRef(null);
  const cats=["All",...new Set(products.map(p=>p.cat).filter(Boolean))];
  const filtered=products.filter(p=>(cat==="All"||p.cat===cat)&&(p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase())));
  const addToCart=(p)=>{if(p.stock<=0)return;setCart(c=>{const ex=c.find(x=>x.id===p.id);if(ex)return c.map(x=>x.id===p.id?{...x,qty:Math.min(x.qty+1,p.stock)}:x);return[...c,{...p,qty:1}];});};
  const removeFromCart=id=>setCart(c=>c.filter(x=>x.id!==id));
  const changeQty=(id,delta)=>setCart(c=>c.map(x=>x.id===id?{...x,qty:Math.max(0,Math.min(x.qty+delta,x.stock))}:x).filter(x=>x.qty>0));
  const playBeep = useCallback((success=true) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (success) {
        // Two-tone success beep: 880Hz → 1046Hz
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1046, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      } else {
        // Low error buzz
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch(e) {}
  }, []);
  const handleScanResult=useCallback((code)=>{
    const trimmed=code.trim();
    if(!trimmed) return;
    const lower=trimmed.toLowerCase();
    // 1. Exact barcode or SKU match (scanner input)
    // 2. Partial name or SKU match (manual keyboard search)
    const found=
      products.find(p=>p.barcode===trimmed||p.sku===trimmed) ||
      products.find(p=>p.sku.toLowerCase()===lower) ||
      products.find(p=>p.name.toLowerCase()===lower) ||
      (trimmed.length>=2 ? products.find(p=>
        p.name.toLowerCase().includes(lower)||
        p.sku.toLowerCase().includes(lower)
      ) : null);
    if(found){
      if(found.stock>0){
        setCart(c=>{const ex=c.find(x=>x.id===found.id);if(ex)return c.map(x=>x.id===found.id?{...x,qty:Math.min(x.qty+1,found.stock)}:x);return[...c,{...found,qty:1}];});
        setScanFlash({name:found.name,emoji:found.emoji,status:"ok"});
        playBeep(true); // ✅ success beep
      } else {
        setScanFlash({name:found.name,emoji:found.emoji,status:"nostock"});
        playBeep(false); // ❌ error buzz
      }
    } else {
      // Show partial matches if any exist — helps cashier pick the right product
      const partials = trimmed.length>=2
        ? products.filter(p=>
            p.name.toLowerCase().includes(lower)||
            p.sku.toLowerCase().includes(lower)
          ).slice(0,4)
        : [];
      setScanFlash({name:trimmed,emoji:"❓",status:"notfound",partials});
      playBeep(false);
    }
    setTimeout(()=>setScanFlash(null),3500);
  },[products, playBeep]);
  // ── Barcode scanner — always-on auto-detect ──────────────────────────────
  // Hardware scanners type characters very fast (< 30ms between keystrokes)
  // then send Enter. We capture this regardless of which element is focused.
  const SCAN_SPEED_THRESHOLD = 50; // ms — human typing is slower than this
  const lastKeyTime = useRef(0);


  useEffect(()=>{
    const onKey=(e)=>{
      const now = Date.now();
      const timeSinceLast = now - lastKeyTime.current;
      lastKeyTime.current = now;

      const activeEl = document.activeElement;
      const tag = activeEl?.tagName?.toLowerCase();
      const isTextInput = (tag==="input"||tag==="textarea"||tag==="select");
      const isScannerSpeed = timeSinceLast < SCAN_SPEED_THRESHOLD;
      const isManualInput = activeEl===manualRef.current;

      if(e.key==="Enter"){
        const buf = scanBuffer.current.trim();
        if(scanTimer.current) clearTimeout(scanTimer.current);

        if(buf.length >= 3){
          // Scanner fired — process regardless of focused element
          // If a different input is focused, blur it momentarily
          if(isTextInput && !isManualInput){
            activeEl.blur();
            setTimeout(()=>activeEl.focus(), 200);
          }
          handleScanResult(buf);
        }
        scanBuffer.current = "";
        return;
      }

      // Only accumulate into scan buffer if:
      // - It's scanner-speed input, OR
      // - The manual scan input is focused
      if(e.key.length===1){
        if(isScannerSpeed || isManualInput || scanBuffer.current.length > 0){
          scanBuffer.current += e.key;
          if(scanTimer.current) clearTimeout(scanTimer.current);
          // Clear buffer if no Enter received within 100ms
          scanTimer.current = setTimeout(()=>{ scanBuffer.current=""; }, 100);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  }, [handleScanResult]);
  const handleManualScan=(e)=>{if(e.key==="Enter"&&manualBarcode.trim()){handleScanResult(manualBarcode.trim());setManualBarcode("");}};
  const subtotal=cart.reduce((s,x)=>s+x.price*x.qty,0);
  const pointsDiscount=pointsRedeemed*POINTS_TO_KSH;
  const discountAmt=Math.min((parseFloat(discountValue)||0)+pointsDiscount,subtotal);
  const afterDiscount=subtotal-discountAmt;
  const tax=Math.round((afterDiscount-(afterDiscount/1.16))*100)/100;
  const deliveryFeeAmt = (cart.length>0 && delivery?.isDelivery===true && Number(delivery?.fee)>0) ? Number(delivery.fee) : 0;
  const total=afterDiscount+deliveryFeeAmt;
  const [payLoading,setPayLoading]=useState(false);
  const [payError,setPayError]=useState("");
  // M-Pesa STK Push state
  const [mpesaPhone,setMpesaPhone]=useState("");
  const [mpesaSubMethod,setMpesaSubMethod]=useState("stk");
  const [stkTarget,setStkTarget]=useState(""); // "till" or "paybill" — auto-set on first use
  const [mpesaStage,setMpesaStage]=useState("idle"); // idle | pushing | waiting | confirmed | failed | expired
  const [mpesaMsg,setMpesaMsg]=useState("");
  const mpesaPollRef=useRef(null);
  const [stkMpesaCode,setStkMpesaCode]=useState("");
  const [manualCode,setManualCode]=useState("");
  const c2bPollRef=useRef(null);

  const clearMpesa=()=>{
    // Only clears stage/msg/polling — does NOT reset sub-method tab
    setMpesaStage("idle");setMpesaMsg("");setStkMpesaCode("");setManualCode("");
    if(mpesaPollRef.current) clearInterval(mpesaPollRef.current);
    if(c2bPollRef.current) clearInterval(c2bPollRef.current);
  };
  const resetMpesa=()=>{
    // Full reset including sub-method — used when closing modal or switching Cash/Card/MPesa
    setMpesaStage("idle");setMpesaMsg("");setStkMpesaCode("");setManualCode("");setMpesaSubMethod("stk");
    if(mpesaPollRef.current) clearInterval(mpesaPollRef.current);
    if(c2bPollRef.current) clearInterval(c2bPollRef.current);
  };

  const handleMpesaPush=async()=>{
    const phone=mpesaPhone.replace(/\s/g,"");
    if(!/^(07|01|2547|2541|\+2547|\+2541)\d{8}$/.test(phone)){
      setMpesaMsg("Enter a valid Safaricom number e.g. 0712345678");return;
    }
    const shop={...SHOP_DEFAULTS,...(shopSettingsProp||getShopSettings())};
    // Determine destination: explicit stkTarget (user chose) or sub-method tab
    let usingTill;
    if(mpesaSubMethod==="till")         usingTill = true;
    else if(mpesaSubMethod==="paybill") usingTill = false;
    else {
      // STK tab — use what user selected, fallback to till if available
      const target = stkTarget || (shop.till ? "till" : "paybill");
      usingTill = (target === "till" && !!shop.till);
    }
    const shortcode        = usingTill ? (shop.till||"") : (shop.paybill||"");
    const transactionType  = usingTill ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";
    const accountReference = usingTill ? "POS" : (shop.paybillAccount||"POS");
    if(!shortcode){
      // Try re-syncing settings from DB before giving up
      const fresh = await syncShopSettings();
      const freshShop = {...SHOP_DEFAULTS,...(fresh||getShopSettings())};
      const freshShortcode = usingTill ? (freshShop.till||"") : (freshShop.paybill||"");
      if(!freshShortcode){
        setMpesaStage("failed");
        setMpesaMsg("No Till or Paybill number set. Ask your admin to save Settings ⚙️ first.");
        return;
      }
      // Got it after re-sync — update and continue
      if(onSettingsSaved) onSettingsSaved(freshShop);
      const resolvedShortcode = freshShortcode;
      setMpesaStage("pushing");setMpesaMsg("");
      try{
        const res=await apiFetch("/api/mpesa/stk-push",{
          method:"POST",
          body:JSON.stringify({phone,amount:Math.ceil(total),shortcode:resolvedShortcode,transactionType,accountReference}),
        });
        const data=await res.json();
        if(!res.ok){setMpesaStage("failed");setMpesaMsg(data.error||"STK Push failed. Try again.");return;}
        setMpesaCheckoutId(data.CheckoutRequestID||data.checkoutRequestId||"");
        setMpesaStage("waiting");
      }catch{setMpesaStage("failed");setMpesaMsg("Network error. Check your connection.");}
      return;
    }
    setMpesaStage("pushing");setMpesaMsg("");
    try{
      const res=await apiFetch("/api/mpesa/stk-push",{
        method:"POST",
        body:JSON.stringify({phone,amount:Math.ceil(total),shortcode,transactionType,accountReference}),
      });
      const data=await res.json();
      if(!res.ok){setMpesaStage("failed");setMpesaMsg(data.error||"STK Push failed. Try again.");return;}
      setMpesaStage("waiting");
      // Poll STK Query (direct Daraja check) every 5 seconds for up to 3 minutes
      // This works even when the callback URL is not publicly accessible (e.g. localhost)
      let attempts=0;
      let consecutiveErrors=0;
      let fulizaOffered=false;  // becomes true the moment we receive code 1
      let fulizaPolls=0;        // counts ALL polls AFTER Fuliza was offered
      mpesaPollRef.current=setInterval(async()=>{
        attempts++;
        // Hard timeout: 20 attempts = 60 seconds
        if(attempts>20){
          clearInterval(mpesaPollRef.current);
          setMpesaStage("timeout");
          setMpesaMsg("M-Pesa request timed out.");
          return;
        }
        // Once Fuliza was offered, count every poll toward the Fuliza timeout
        // (Safaricom oscillates between code 1 and undefined while customer decides)
        if(fulizaOffered){
          fulizaPolls++;
          if(fulizaPolls>10){ // ~30s after Fuliza was offered
            clearInterval(mpesaPollRef.current);
            setMpesaStage("failed");
            setMpesaMsg("Customer did not complete Fuliza payment.");
            return;
          }
        }
        try{
          const pr=await apiFetch(`/api/mpesa/stk-query/${data.CheckoutRequestID}`);
          const pd=await pr.json();

          if(pd.status==="confirmed"){
            clearInterval(mpesaPollRef.current);
            setMpesaStage("confirmed");
            setStkMpesaCode(pd.mpesaCode||"");
            await finishOrder("mobile");

          } else if(pd.status==="failed"){
            clearInterval(mpesaPollRef.current);
            setMpesaStage("failed");
            setMpesaMsg(pd.message||"Payment cancelled or failed.");

          } else if(pd.status==="fuliza"){
            // Insufficient balance — Fuliza is being offered to the customer
            fulizaOffered=true;
            consecutiveErrors=0;
            setMpesaStage("fuliza");
            setMpesaMsg(pd.message||"Customer can accept Fuliza to complete payment.");

          } else if(pd.status==="error"){
            // Backend couldn't reach Daraja (e.g. access token expired)
            consecutiveErrors++;
            if(consecutiveErrors>=3){
              clearInterval(mpesaPollRef.current);
              setMpesaStage("timeout");
              setMpesaMsg("Cannot reach M-Pesa servers. Check if the customer paid and enter their code manually.");
            }

          } else {
            // "pending" (undefined ResultCode) — keep polling, reset error counter
            consecutiveErrors=0;
          }

        }catch(e){
          consecutiveErrors++;
          console.error("Poll error",e);
          if(consecutiveErrors>=3){
            clearInterval(mpesaPollRef.current);
            setMpesaStage("timeout");
            setMpesaMsg("Cannot reach M-Pesa servers. Check if the customer paid and enter their code manually.");
          }
        }
      },3000); // 3s polling — detects cancellation within ~3 seconds
    }catch{setMpesaStage("failed");setMpesaMsg("Cannot connect to server.");}
  };

  const startC2BSession=async()=>{
    setMpesaStage("waiting");setMpesaMsg("");
    try{
      const res=await apiFetch("/api/mpesa/c2b/session",{method:"POST",body:JSON.stringify({amount:Math.ceil(total)})});
      const data=await res.json();
      if(!res.ok){setMpesaStage("failed");setMpesaMsg(data.error||"Could not start payment session.");return;}
      // Poll every 3 seconds for up to 10 minutes
      let attempts=0;
      c2bPollRef.current=setInterval(async()=>{
        attempts++;
        if(attempts>200){clearInterval(c2bPollRef.current);setMpesaStage("failed");setMpesaMsg("Payment timed out. Try again.");return;}
        try{
          const pr=await apiFetch(`/api/mpesa/c2b/status/${data.sessionId}`);
          const pd=await pr.json();
          if(pd.status==="confirmed"){
            clearInterval(c2bPollRef.current);
            setMpesaStage("confirmed");
            await finishOrder("mobile");
          } else if(pd.status==="expired"){
            clearInterval(c2bPollRef.current);
            setMpesaStage("failed");
            setMpesaMsg("Session expired. Please try again.");
          }
        }catch(e){console.error("C2B poll error",e);}
      },3000);
    }catch{setMpesaStage("failed");setMpesaMsg("Cannot connect to server.");}
  };

  const finishOrder=async(method="cash")=>{
    if(branches.length>0&&!activeBranch){setPayError("No branch selected. Please select a branch before processing a sale.");setPayLoading(false);return;}
    setPayLoading(true);setPayError("");
    const payload={
      items:cart.map(x=>({productId:x.id,quantity:x.qty})),
      customerId:selCust?.id||null,
      paymentMethod:method,
      cashTendered:method==="cash"?(parseFloat(cashInput)||null):null,
      discountAmount:discountAmt,
      pointsRedeemed:pointsRedeemed||0,
      branchId:activeBranch?.id||null,
      ...(delivery?.isDelivery?{delivery:{
        isDelivery:true,
        name:delivery.name||"",
        phone:delivery.phone||"",
        altPhone:delivery.altPhone||"",
        address:delivery.address||"",
        area:delivery.area||"",
        landmark:delivery.landmark||"",
        town:delivery.town||"",
        fee:Number(delivery.fee)||0,
        notes:delivery.notes||"",
        deliveryTime:delivery.deliveryTime||"",
      }}:{}),
    };
    const methodLabel=method==="mobile"?"M-Pesa":method==="card"?"Card":"Cash";
    const localOrder={id:"OFFLINE-"+Date.now(),date:new Date().toLocaleString(),customer:selCust?.name||"Walk-in",items:[...cart],subtotal,discount:discountAmt,tax,total,method:methodLabel,cash:method==="cash"?(parseFloat(cashInput)||0):0,delivery:delivery||null};

    // ── Optimistic stock deduction (works online AND offline) ──
    setProducts(ps=>ps.map(p=>{const ci=cart.find(c=>c.id===p.id);return ci?{...p,stock:p.stock-ci.qty}:p;}));

    if(!navigator.onLine){
      // Queue for later sync
      try{
        await idbAdd("queue",{payload,localOrder,queuedAt:Date.now()});
        if(onQueueAdd) onQueueAdd();
      }catch(e){console.error("IDB queue error",e);}
      setCart([]);setDiscountValue("");setSelCust(null);setPointsRedeemed(0);setCashInput("");setPayModal(false);resetMpesa();setDelivery({isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""});localStorage.removeItem("starmart_delivery");localStorage.removeItem("starmart_cart");localStorage.removeItem("starmart_pos_customer");
      printReceipt(localOrder);
      setReceiptModal({...localOrder,offline:true,delivery:delivery||null});
      setPayLoading(false);
      return;
    }

    try{
      const res=await apiFetch("/api/orders",{method:"POST",body:JSON.stringify(payload)});
      const data=await res.json();
      if(!res.ok){
        // Roll back stock if server rejected
        setProducts(ps=>ps.map(p=>{const ci=cart.find(c=>c.id===p.id);return ci?{...p,stock:p.stock+ci.qty}:p;}));
        setPayError(data.error||"Order save failed.");setPayLoading(false);return;
      }
      const pointsEarned=selCust?Math.floor(total/100):0;
      const initialPoints=selCust?.points||0;
      const newPointsBalance=Math.max(0, initialPoints - pointsRedeemed + pointsEarned);
      const order={...localOrder,id:data.orderNumber,
        pointsEarned,
        pointsRedeemed,
        initialPoints,
        custName:selCust?.name||null,
      };
      // Update the customer's points in the local list immediately — no refresh needed
      setPosCustomers(prev=>prev.map(c=>
        c.id===selCust?.id ? {...c, points: newPointsBalance} : c
      ));
      setPointsRedeemed(0);
      setCart([]);setDiscountValue("");setSelCust(null);setCashInput("");setPayModal(false);resetMpesa();setDelivery({isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""});localStorage.removeItem("starmart_delivery");
      printReceipt(order);
      setReceiptModal(order);
    }catch{
      // Network dropped mid-request — queue it
      try{
        await idbAdd("queue",{payload,localOrder,queuedAt:Date.now()});
        if(onQueueAdd) onQueueAdd();
      }catch(e){console.error("IDB queue error",e);}
      setCart([]);setDiscountValue("");setSelCust(null);setCashInput("");setPayModal(false);resetMpesa();setDelivery({isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""});localStorage.removeItem("starmart_delivery");
      printReceipt(localOrder);
      setReceiptModal({...localOrder,offline:true,delivery:delivery||null});
    }
    setPayLoading(false);
  };

  const processPayment=async()=>{
    if(cart.length===0)return;
    await finishOrder(payMethod==="M-Pesa"?"mobile":payMethod.toLowerCase());
  };
  const cashFloat=parseFloat(cashInput)||0;

  return(
    <div style={{display:"flex",flex:1,minHeight:0,background:C.bg,fontFamily:"'Inter',sans-serif"}}>

      {/* ── Scan Toast ── */}
      {scanFlash&&(
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:3000,
          padding:"12px 20px",borderRadius:12,display:"flex",alignItems:"center",gap:12,
          background:scanFlash.status==="ok"?"#0D2318":scanFlash.status==="nostock"?"#2A1500":"#2A0A0A",
          border:`1px solid ${scanFlash.status==="ok"?C.green:scanFlash.status==="nostock"?"#F97316":C.red}60`,
          boxShadow:"0 12px 40px rgba(0,0,0,0.6)",animation:"fadeIn 0.2s ease"}}>
          <div style={{width:38,height:38,borderRadius:10,background:scanFlash.status==="ok"?C.green+"18":C.red+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>{scanFlash.emoji}</div>
          <div>
            <div style={{fontSize:16,fontWeight:600,color:scanFlash.status==="ok"?C.green:scanFlash.status==="nostock"?"#F97316":C.red}}>{scanFlash.name}</div>
            <div style={{fontSize:15,color:C.text3,marginTop:1}}>
              {scanFlash.status==="ok"?"Added to cart":scanFlash.status==="nostock"?"Out of stock":
               scanFlash.partials?.length>0?`${scanFlash.partials.length} similar — tap to add`:"Product not found"}
            </div>
            {scanFlash.status==="notfound"&&scanFlash.partials?.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:6,minWidth:220}}>
                {scanFlash.partials.map(p=>(
                  <button key={p.id} onClick={()=>{
                    if(p.stock>0){
                      setCart(c=>{const ex=c.find(x=>x.id===p.id);if(ex)return c.map(x=>x.id===p.id?{...x,qty:Math.min(x.qty+1,p.stock)}:x);return[...c,{...p,qty:1}];});
                      playBeep(true);
                    }
                    setScanFlash(null);
                  }}
                    style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                      padding:"6px 10px",borderRadius:8,
                      background:p.stock>0?"rgba(99,102,241,0.12)":"rgba(255,255,255,0.04)",
                      border:`1px solid ${p.stock>0?C.blue:C.border}`,
                      color:C.text,cursor:p.stock>0?"pointer":"default",fontSize:13}}>
                    <span>{p.emoji||"📦"} {p.name}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",color:p.stock>0?C.green:C.red,fontSize:13}}>
                      {p.stock>0?`KSh ${p.price.toLocaleString()}`:"Out"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════ LEFT — PRODUCT BROWSER ══════════ */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",borderRight:`1px solid ${C.border}`}}>

        {/* Top bar: scanner + search */}
        <div className="r-pos-topbar" style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:10,background:C.sidebar,flexWrap:"wrap"}}>
          {/* Barcode scanner input */}
          <div className="r-pos-scan" style={{position:"relative",width:220,flexShrink:0}}>
            <svg style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",opacity:0.5}} width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth={2.5}><path d="M3 9V6a2 2 0 012-2h2M3 15v3a2 2 0 002 2h2M15 4h2a2 2 0 012 2v3M15 20h2a2 2 0 002-2v-3M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>
            <input ref={manualRef} value={manualBarcode} onChange={e=>setManualBarcode(e.target.value)} onKeyDown={handleManualScan}
              placeholder="📷 Scan / SKU…"
              style={{width:"100%",background:"#0D1117",border:`1px solid ${C.green}44`,borderRadius:8,padding:"9px 10px 9px 32px",
                color:C.text,fontFamily:"'DM Mono',monospace",fontSize:14,outline:"none",transition:"all 0.15s"}}
              onFocus={e=>{e.target.style.borderColor=C.green;e.target.style.boxShadow=`0 0 0 3px ${C.green}18`;}}
              onBlur={e=>{e.target.style.borderColor=C.green+"44";e.target.style.boxShadow="none";}}/>
            <div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:C.green,boxShadow:`0 0 6px ${C.green}`}}/>
            </div>
          </div>
          {/* Search */}
          <div className="r-pos-search" style={{flex:1,position:"relative"}}>
            <svg style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)"}} width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={C.text3} strokeWidth={2.5}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Search products by name or SKU…"
              style={{width:"100%",background:"#0D1117",border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 10px 9px 34px",
                color:C.text,fontSize:16,outline:"none",transition:"all 0.15s"}}
              onFocus={e=>{e.target.style.borderColor=C.blue;e.target.style.boxShadow=`0 0 0 3px ${C.blueGlow}`;}}
              onBlur={e=>{e.target.style.borderColor=C.border;e.target.style.boxShadow="none";}}/>
          </div>
          <div className="r-pos-count" style={{display:"flex",alignItems:"center",padding:"0 12px",borderRadius:8,background:C.border,fontSize:14,color:C.text3,fontWeight:500,whiteSpace:"nowrap"}}>
            {filtered.length} items
          </div>
        </div>

        {/* Category filters */}
        <div className="r-cat-bar" style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:6,overflowX:"auto",flexShrink:0,scrollbarWidth:"none"}}>
          {cats.map(c=>(
            <button key={c} onClick={()=>setCat(c)} className="cat-pill"
              style={{padding:"6px 16px",borderRadius:20,border:`1px solid ${cat===c?C.blue:C.border}`,
                background:cat===c?"rgba(99,102,241,0.15)":"transparent",
                color:cat===c?"#818CF8":C.text3,
                fontSize:15,fontWeight:cat===c?700:500,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
                letterSpacing:"0.01em"}}>
              {c}
            </button>
          ))}
        </div>

        {/* Product grid */}
        <div style={{flex:1,overflowY:"auto",padding:"14px 16px"}}>
          {filtered.length===0?(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:300,gap:12,color:C.text3}}>
              <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <div style={{fontSize:17,fontWeight:500,color:C.text2}}>No products found</div>
              <div style={{fontSize:14}}>Try a different search or category</div>
            </div>
          ):(
            <div className="r-grid-products" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
              {filtered.map(p=>{
                const inCart=cart.find(x=>x.id===p.id);
                const oos=p.stock<=0;
                return(
                  <div key={p.id} className="pos-card" onClick={()=>addToCart(p)}
                    style={{background:C.card,border:`1px solid ${inCart?"#6366F144":C.border}`,borderRadius:12,
                      padding:"12px 12px 10px",cursor:oos?"not-allowed":"pointer",
                      opacity:oos?0.45:1,position:"relative",overflow:"hidden",userSelect:"none"}}>
                    {/* In-cart badge */}
                    {inCart&&<div style={{position:"absolute",top:8,right:8,background:C.blue,color:"#fff",
                      borderRadius:20,fontSize:14,fontWeight:700,padding:"1px 7px",zIndex:1}}>
                      ×{inCart.qty}
                    </div>}
                    {/* Image / emoji */}
                    <div className="r-card-img" style={{width:"100%",height:100,borderRadius:8,overflow:"hidden",marginBottom:8,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      background:inCart?"rgba(99,102,241,0.08)":"rgba(255,255,255,0.03)"}}>
                      {p.image
                        ?<img src={p.image} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        :<span style={{fontSize:36,lineHeight:1}}>{p.emoji||"📦"}</span>}
                    </div>
                    {/* Name */}
                    <div className="r-card-name" style={{fontSize:16,fontWeight:700,letterSpacing:"-0.01em",lineHeight:1.3,marginBottom:5,
                      display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                      {p.name}
                    </div>
                    {/* SKU */}
                    <div className="r-card-sku" style={{fontSize:13,color:C.text3,marginBottom:8,fontFamily:"'DM Mono',monospace",letterSpacing:'0.02em'}}>{p.sku}</div>
                    {/* Price + stock row */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span className="r-card-price" style={{color:C.text}}>
                        KSh {p.price.toLocaleString("en-KE")}
                      </span>
                      <span style={{fontSize:15,fontWeight:700,padding:"2px 9px",borderRadius:20,
                        background:p.stock<LST?C.red+"18":C.green+"12",
                        color:p.stock<LST?C.red:C.green}}>
                        {oos?"Out":p.stock<LST?`Low: ${p.stock}`:`${p.stock}`}
                      </span>
                    </div>
                    {/* Stock bar */}
                    <div style={{marginTop:8,height:2,borderRadius:2,background:C.border,overflow:"hidden"}}>
                      <div style={{height:"100%",borderRadius:2,width:`${Math.min(100,(p.stock/20)*100)}%`,
                        background:p.stock<LST?C.red:p.stock<LST*2?C.amber:C.green,transition:"width 0.3s"}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ══════════ MOBILE — Cart FAB + Drawer ══════════ */}
      {isMobile&&(
        <>
          {/* Overlay */}
          <div className={`r-overlay${cartOpen?" open":""}`} onClick={()=>setCartOpen(false)}/>
          {/* FAB */}
          <button className="r-cart-fab" onClick={()=>setCartOpen(o=>!o)}>
            🛒
            {cart.length>0&&<span className="r-cart-badge">{cart.reduce((s,x)=>s+x.qty,0)}</span>}
          </button>
        </>
      )}

      {/* ══════════ RIGHT — CART + CHECKOUT ══════════ */}
      <div className={"r-cart-desktop"+(isMobile?(" r-cart-drawer"+(cartOpen?" open":"")):"") } style={{width:isMobile?undefined:390,flexShrink:0,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden",background:C.sidebar}}>

        {/* Cart header */}
        <div style={{padding:"14px 16px 12px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {isMobile&&<button onClick={()=>setCartOpen(false)} style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:20,lineHeight:1,padding:"0 4px",marginRight:2}}>✕</button>}
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={C.text2} strokeWidth={2}><path d="M6 2 3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
            <div>
              <div style={{fontSize:17,fontWeight:700,letterSpacing:"-0.02em"}}>
                Cart {cart.length>0&&<span style={{fontSize:14,fontWeight:600,color:C.blue,background:"rgba(99,102,241,0.15)",padding:"1px 8px",borderRadius:20,marginLeft:4}}>{cart.reduce((s,x)=>s+x.qty,0)}</span>}
              </div>

            </div>
          </div>
          <div style={{display:"flex",gap:6}}>
            {cart.length>0&&(
              <button onClick={()=>{
                  // Audit: log cart clear if cart had items (theft detection)
                  if(cart.length>0){
                    const total=cart.reduce((s,x)=>s+x.price*x.qty,0);
                    apiFetch("/api/security/audit",{method:"POST",body:JSON.stringify({
                      action:"CART_CLEARED",
                      details:{itemCount:cart.length,cartValue:total,
                        items:cart.map(x=>({name:x.name,qty:x.qty,price:x.price}))}
                    })}).catch(()=>{});
                  }
                  setCart([]);setDelivery({isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""});localStorage.removeItem("starmart_delivery");}}
                style={{padding:"5px 14px",borderRadius:7,border:`1px solid ${C.red}66`,background:"transparent",
                  color:C.red,fontSize:14,fontWeight:600,cursor:"pointer",transition:"all 0.15s"}}
                onMouseEnter={e=>{e.currentTarget.style.background=C.red;e.currentTarget.style.color="#fff";e.currentTarget.style.borderColor=C.red;e.currentTarget.style.boxShadow=`0 2px 10px ${C.red}55`;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=C.red;e.currentTarget.style.borderColor=`${C.red}66`;e.currentTarget.style.boxShadow="none";}}>
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Customer strip — compact single line */}
        <div style={{padding:"8px 14px",borderBottom:`1px solid ${C.border}`,flexShrink:0,
          background:selCust?"rgba(34,197,94,0.06)":"transparent"}}>
          {perms.posCustomerPick?(
            selCust?(
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:28,height:28,borderRadius:8,flexShrink:0,
                  background:C.green+"22",border:`1.5px solid ${C.green}44`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontWeight:800,fontSize:13,color:C.green}}>
                  {selCust.name[0].toUpperCase()}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:14,color:C.green,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{selCust.name}</div>
                  <div style={{fontSize:12,color:C.text3}}>⭐ {(selCust.points||0).toLocaleString()} pts{cart.length>0?` · +${Math.floor(total/100)} this sale`:""}</div>
                </div>
                <button onClick={()=>{setSelCust(null);setPointsRedeemed(0);}}
                  style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:18,lineHeight:1,padding:"2px 4px",flexShrink:0}}>
                  ✕
                </button>
              </div>
            ):(
              <CustomerSearchPicker
                customers={posCustomers}
                onSelect={setSelCust}
                onAddNew={perms.customersAdd?()=>setPosAddCustModal(true):null}
              />
            )
          ):(
            <div style={{fontSize:13,color:C.text3,display:"flex",alignItems:"center",gap:6}}>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              Customer tracking — Manager+
            </div>
          )}
        </div>

        {/* Cart items */}
        <div style={{flex:"1 1 0%",minHeight:0,overflowY:"auto"}}>
          {cart.length===0?(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:12,color:C.text3,padding:"24px 20px"}}>
              <div style={{width:64,height:64,borderRadius:20,
                background:"rgba(99,102,241,0.08)",border:`1px dashed ${C.blue}44`,
                display:"flex",alignItems:"center",justifyContent:"center"}}>
                <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth={1.2} opacity={0.5}>
                  <path d="M6 2 3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
                  <line x1="3" y1="6" x2="21" y2="6"/>
                  <path d="M16 10a4 4 0 01-8 0"/>
                </svg>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:16,fontWeight:700,color:C.text2,marginBottom:4}}>Cart is empty</div>
                <div style={{fontSize:13,color:C.text3}}>Scan or tap a product to add</div>
              </div>
            </div>
          ):cart.map((item,idx)=>(
            /* ── World-class cart row: image · name/price · qty stepper · total ── */
            <div key={item.id} className="cart-row"
              style={{display:"flex",alignItems:"center",gap:10,
                padding:"10px 14px",
                borderBottom:`1px solid ${C.border}`,
                background:"transparent",transition:"background 0.1s"}}
              onMouseEnter={e=>e.currentTarget.style.background="rgba(99,102,241,0.04)"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              {/* Thumbnail */}
              <div style={{width:42,height:42,borderRadius:10,overflow:"hidden",flexShrink:0,
                background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",
                border:`1px solid ${C.border}`}}>
                {item.image
                  ?<img src={item.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  :<span style={{fontSize:20}}>{item.emoji||"📦"}</span>}
              </div>
              {/* Name + price + qty — stacked for full name visibility */}
              <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>
                {/* Full product name — no truncation */}
                <div className="r-cart-item-name" style={{
                  whiteSpace:"normal",wordBreak:"break-word",
                  lineHeight:1.3}}>{item.name}</div>
                {/* Bottom row: unit price · qty stepper · line total */}
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,color:C.text3,fontFamily:"'DM Mono',monospace",flexShrink:0}}>
                    KSh {item.price.toLocaleString("en-KE")}
                  </span>
                  {/* Qty stepper */}
                  <div style={{display:"flex",alignItems:"center",gap:0,flexShrink:0,
                    background:"rgba(255,255,255,0.04)",borderRadius:8,border:`1px solid ${C.border}`,overflow:"hidden"}}>
                    <button className="qty-btn" onClick={()=>changeQty(item.id,-1)}
                      style={{width:28,height:28,border:"none",background:"transparent",
                        color:C.text,cursor:"pointer",fontSize:16,fontWeight:500,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        borderRight:`1px solid ${C.border}`}}>−</button>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:700,
                      width:28,textAlign:"center",color:C.text}}>{item.qty}</span>
                    <button className="qty-btn" onClick={()=>changeQty(item.id,1)}
                      style={{width:28,height:28,border:"none",background:"transparent",
                        color:C.text,cursor:"pointer",fontSize:16,fontWeight:500,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        borderLeft:`1px solid ${C.border}`}}>+</button>
                  </div>
                  {/* Line total */}
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:700,
                    color:C.green,letterSpacing:"-0.02em",marginLeft:"auto"}}>
                    {ksh(item.price*item.qty)}
                  </div>
                </div>
              </div>
              {/* Remove */}
              <button onClick={()=>removeFromCart(item.id)}
                style={{background:"none",border:"none",color:C.text3,cursor:"pointer",
                  width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",
                  borderRadius:5,flexShrink:0,transition:"all 0.1s",padding:0}}
                onMouseEnter={e=>{e.currentTarget.style.color=C.red;}}
                onMouseLeave={e=>{e.currentTarget.style.color=C.text3;}}>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          ))}
        </div>

        {/* ── World-class bottom panel ── */}
        <div style={{flex:"0 0 auto",borderTop:`1px solid ${C.border}`,background:C.sidebar}}>

          {/* Points redemption — inline pill when customer selected */}
          {selCust&&(selCust.points||0)>0&&(
            <div style={{padding:"6px 12px 0"}}>
              {pointsRedeemed===0?(
                <button onClick={()=>setPointsRedeemed(Math.min(selCust.points,Math.floor(subtotal)))}
                  style={{width:"100%",padding:"5px 12px",borderRadius:7,cursor:"pointer",
                    border:`1px solid ${C.amber}44`,background:"rgba(245,158,11,0.06)",
                    color:C.amber,fontSize:13,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>⭐ Redeem {(selCust.points||0).toLocaleString()} pts</span>
                  <span style={{fontSize:12,color:C.text3}}>tap to apply</span>
                </button>
              ):(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",borderRadius:7,
                  background:"rgba(245,158,11,0.08)",border:`1px solid ${C.amber}44`}}>
                  <span style={{fontSize:13,fontWeight:700,color:C.amber,flex:1}}>
                    ⭐ −{pointsRedeemed} pts = −{ksh(pointsRedeemed*POINTS_TO_KSH)}
                  </span>
                  <div style={{display:"flex",gap:4}}>
                    {[25,50,Math.min(selCust.points,Math.floor(subtotal))].filter((v,i,a)=>v>0&&a.indexOf(v)===i).map(pts=>(
                      <button key={pts} onClick={()=>setPointsRedeemed(Math.min(pts,selCust.points,Math.floor(subtotal)))}
                        style={{padding:"2px 7px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700,
                          border:`1px solid ${C.amber}44`,background:"transparent",color:C.amber}}>
                        {pts===Math.min(selCust.points,Math.floor(subtotal))?"Max":`${pts}`}
                      </button>
                    ))}
                  </div>
                  <button onClick={()=>setPointsRedeemed(0)}
                    style={{fontSize:14,color:C.red,background:"none",border:"none",cursor:"pointer",fontWeight:700,padding:"0 2px"}}>✕</button>
                </div>
              )}
            </div>
          )}

          {/* Totals row — compact 3-line summary */}
          <div style={{padding:"8px 14px 6px",display:"flex",flexDirection:"column",gap:3}}>
            {/* Discount input inline with subtotal */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:14,color:C.text3}}>
              <span>Subtotal</span>
              <span style={{fontFamily:"'DM Mono',monospace",color:C.text2}}>{ksh(subtotal)}</span>
            </div>
            {perms.posDiscounts&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <label style={{fontSize:12,color:C.text3,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",flexShrink:0}}>Disc.</label>
                <input type="number" min="0" value={discountValue} onChange={e=>setDiscountValue(e.target.value)}
                  onBlur={e=>{
                    e.target.style.borderBottomColor=C.border;
                    const disc=parseFloat(discountValue)||0;
                    if(disc>0 && cart.length>0){
                      const subtotal=cart.reduce((s,x)=>s+x.price*x.qty,0);
                      apiFetch("/api/security/audit",{method:"POST",body:JSON.stringify({
                        action:"DISCOUNT_APPLIED",
                        details:{discountAmount:disc,subtotal,
                          discountPct:Math.round(disc/subtotal*100),
                          items:cart.map(x=>({name:x.name,qty:x.qty,price:x.price}))}
                      })}).catch(()=>{});
                    }
                  }}
                  onFocus={e=>e.target.style.borderBottomColor=C.amber}
                  placeholder="0"
                  style={{flex:1,background:"transparent",border:"none",borderBottom:`1px solid ${C.border}`,color:discountAmt>0?C.amber:C.text3,
                    padding:"2px 4px",fontSize:13,outline:"none",fontFamily:"'DM Mono',monospace",textAlign:"right",
                    maxWidth:90}}/>
                {discountAmt>0&&<span style={{fontSize:13,color:C.amber,fontWeight:600,flexShrink:0}}>−{ksh(discountAmt)}</span>}
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.text3}}>
              <span>VAT (16% incl.)</span>
              <span style={{fontFamily:"'DM Mono',monospace",color:C.text2}}>{ksh(tax)}</span>
            </div>
          </div>

          {/* GRAND TOTAL — big, bold, green */}
          <div style={{margin:"0 12px 8px",padding:"10px 14px",borderRadius:10,
            background:"rgba(34,197,94,0.12)",border:`1.5px solid ${C.green}44`,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:12,fontWeight:800,color:C.green,letterSpacing:"0.08em",textTransform:"uppercase",opacity:0.85}}>TOTAL TO PAY</div>
              <div style={{fontSize:18,fontWeight:800,color:C.green,marginTop:1}}>
                {cart.reduce((s,x)=>s+x.qty,0)} item{cart.reduce((s,x)=>s+x.qty,0)!==1?"s":""}
              </div>
            </div>
            <div className="r-cart-total-amt" style={{}}>
              {ksh(total)}
            </div>
          </div>

          {/* Payment method selector — 3 compact tabs */}
          <div style={{padding:"0 12px 8px",display:"flex",gap:5}}>
            {["Cash","Card","M-Pesa"].map(m=>(
              <button key={m} onClick={()=>{setPayMethod(m);resetMpesa();}}
                style={{flex:1,padding:"6px 4px",borderRadius:8,cursor:"pointer",
                  border:`1.5px solid ${payMethod===m?(m==="Cash"?C.amber:m==="Card"?C.blue:C.green):C.border}`,
                  background:payMethod===m?(m==="Cash"?"rgba(245,158,11,0.12)":m==="Card"?"rgba(99,102,241,0.12)":"rgba(34,197,94,0.12)"):"transparent",
                  color:payMethod===m?(m==="Cash"?C.amber:m==="Card"?"#818CF8":C.green):C.text3,
                  display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"all 0.12s"}}>
                <span style={{fontSize:16}}>{m==="Cash"?"💵":m==="Card"?"💳":"📱"}</span>
                <span style={{fontSize:13,fontWeight:600}}>{m}</span>
              </button>
            ))}
          </div>

          {/* Charge button */}
          <div style={{padding:"0 12px 12px"}}>
            {/* ── No-branch warning — only when branches are configured ── */}
            {branches.length>0&&!activeBranch&&cart.length>0&&(
              <div style={{margin:"0 0 8px",padding:"10px 12px",borderRadius:9,
                background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.4)",
                display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:18,flexShrink:0}}>⚠️</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:C.amber}}>No branch selected</div>
                  <div style={{fontSize:12,color:C.text3,marginTop:1}}>Pick a branch from the header to process this sale</div>
                </div>
              </div>
            )}
            <button onClick={()=>{
                const needsBranch=branches.length>0&&!activeBranch;
                if(cart.length>0&&!needsBranch) openPayModal();
              }}
              style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",
                cursor:(cart.length>0&&!(branches.length>0&&!activeBranch))?"pointer":"not-allowed",
                background:cart.length===0?"#1F2937":
                  (branches.length>0&&!activeBranch)?"rgba(245,158,11,0.15)":
                  "linear-gradient(135deg,#6366F1,#4F46E5)",
                color:cart.length===0?C.text3:
                  (branches.length>0&&!activeBranch)?C.amber:"#fff",
                fontSize:16,fontWeight:700,letterSpacing:"-0.01em",
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                transition:"all 0.15s",
                opacity:cart.length===0?0.45:(branches.length>0&&!activeBranch)?0.9:1,
                boxShadow:(cart.length>0&&!(branches.length>0&&!activeBranch))?"0 4px 16px rgba(99,102,241,0.4)":"none"}}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>
              {branches.length>0&&!activeBranch&&cart.length>0?"⚠️ Select a Branch First":"Charge "+payMethod+(cart.length>0?" · "+ksh(total):"")}
            </button>
          </div>
        </div>
      </div>

      {/* ══════════ QUICK ADD CUSTOMER MODAL ══════════ */}
      {posAddCustModal&&(
        <Modal title="New Customer" onClose={()=>{setPosAddCustModal(false);setPosAddCustError("");}}>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{fontSize:15,color:C.text3,marginBottom:4}}>
              Add a new customer to link this sale and start earning loyalty points.
            </div>
            {[["Full Name *","name","text"],["Phone","phone","tel"],["Email","email","email"]].map(([lbl,key,type])=>(
              <div key={key}>
                <label style={{fontSize:14,color:C.text2,display:"block",marginBottom:4}}>{lbl}</label>
                <Input type={type} value={posNewCustForm[key]}
                  onChange={e=>setPosNewCustForm(f=>({...f,[key]:e.target.value}))}
                  placeholder={lbl.replace(" *","")} autoFocus={key==="name"}/>
              </div>
            ))}
            {posAddCustError&&(
              <div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",
                borderRadius:8,padding:"10px 12px",fontSize:15,color:C.red}}>
                ⚠️ {posAddCustError}
              </div>
            )}
            <Btn onClick={addCustFromPOS} disabled={posNewCustSaving||!posNewCustForm.name.trim()}
              style={{width:"100%",justifyContent:"center",marginTop:4}}>
              {posNewCustSaving
                ?<><span style={{width:14,height:14,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite",marginRight:8}}/>Saving…</>
                :"Add & Link to Sale"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ══════════ PAYMENT MODAL ══════════ */}
      {payModal&&(
        <Modal title="Complete Payment" onClose={()=>{setPayModal(false);resetMpesa();setDelivery(d=>({...d,isDelivery:false}));}} wide>
          <div className="r-pay-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>

            {/* LEFT — Method + input */}
            <div>
              {/* Method tabs */}
              <div style={{display:"flex",gap:6,marginBottom:14}}>
                {["Cash","Card","M-Pesa"].map(m=>(
                  <button key={m} onClick={()=>{setPayMethod(m);resetMpesa();}}
                    style={{flex:1,padding:"10px 6px",borderRadius:9,border:`2px solid ${payMethod===m?C.blue:C.border}`,
                      background:payMethod===m?"rgba(99,102,241,0.12)":C.card,
                      color:payMethod===m?"#818CF8":C.text2,fontWeight:600,fontSize:15,cursor:"pointer",
                      display:"flex",flexDirection:"column",alignItems:"center",gap:4,transition:"all 0.15s"}}>
                    <span style={{fontSize:20}}>{m==="Cash"?"💵":m==="Card"?"💳":"📱"}</span>
                    <span>{m}</span>
                  </button>
                ))}
              </div>

              {/* Cash */}
              {payMethod==="Cash"&&<>
                <label style={{fontSize:13,color:C.text3,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Cash Received (KSh)</label>
                <input type="number" value={cashInput} onChange={e=>setCashInput(e.target.value)}
                  placeholder="0.00" autoFocus
                  style={{width:"100%",background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,
                    borderRadius:8,padding:"12px",fontSize:22,fontFamily:"'DM Mono',monospace",outline:"none",
                    letterSpacing:"-0.02em",textAlign:"right",transition:"all 0.15s",marginBottom:10}}
                  onFocus={e=>{e.target.style.borderColor=C.blue;e.target.style.boxShadow=`0 0 0 3px ${C.blueGlow}`;}}
                  onBlur={e=>{e.target.style.borderColor=C.border;e.target.style.boxShadow="none";}}/>
                {/* Quick cash buttons */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12}}>
                  {[500,1000,2000,5000].map(v=>(
                    <button key={v} onClick={()=>setCashInput(String(v))}
                      style={{padding:"8px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card,
                        color:C.text2,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"'DM Mono',monospace",
                        transition:"all 0.15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.text;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text2;}}>
                      KSh {v.toLocaleString()}
                    </button>
                  ))}
                </div>
                {cashFloat>=total&&(
                  <div style={{background:"rgba(34,197,94,0.1)",border:`1px solid ${C.green}33`,borderRadius:10,padding:"12px 14px"}}>
                    <div style={{fontSize:13,color:C.green,fontWeight:600,marginBottom:4,letterSpacing:"0.04em",textTransform:"uppercase"}}>Change Due</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:28,fontWeight:500,color:C.green,letterSpacing:"-0.03em"}}>
                      KSh {(cashFloat-total).toLocaleString("en-KE",{minimumFractionDigits:2})}
                    </div>
                  </div>
                )}
              </>}

              {/* Card */}
              {payMethod==="Card"&&(
                <div style={{textAlign:"center",padding:"20px 0"}}>
                  <div style={{width:72,height:72,borderRadius:16,background:"rgba(99,102,241,0.12)",
                    border:`1px solid ${C.blue}33`,display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:32,margin:"0 auto 14px"}}>💳</div>
                  <div style={{fontSize:17,fontWeight:600,marginBottom:4}}>Present card to reader</div>
                  <div style={{fontSize:15,color:C.text3}}>Waiting for card payment…</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:500,color:C.blue,
                    marginTop:14,letterSpacing:"-0.03em"}}>
                    KSh {total.toLocaleString("en-KE",{minimumFractionDigits:2})}
                  </div>
                </div>
              )}

              {/* M-Pesa */}
              {payMethod==="M-Pesa"&&(()=>{
                const shop={...SHOP_DEFAULTS,...(shopSettingsProp||getShopSettings())};
                const MPESA_METHODS=[
                  {id:"stk",    label:"STK Push",         icon:"📲", note:"Prompt phone"},
                  {id:"paybill",label:"Paybill",           icon:"🏦", note:"Paybill No."},
                  {id:"till",   label:"Buy Goods",         icon:"🏪", note:"Till No."},
                  {id:"pochi",  label:"Pochi",             icon:"👜", note:"Pochi"},
                  {id:"send",   label:"Send Money",        icon:"💸", note:"Phone"},
                ];
                return(<>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:12}}>
                    {MPESA_METHODS.map(m=>(
                      <button key={m.id} onClick={()=>{setMpesaSubMethod(m.id);clearMpesa();}}
                        style={{padding:"8px 6px",borderRadius:8,
                          border:`1.5px solid ${mpesaSubMethod===m.id?C.green:C.border}`,
                          background:mpesaSubMethod===m.id?"rgba(34,197,94,0.1)":C.card,
                          color:mpesaSubMethod===m.id?C.green:C.text2,
                          fontWeight:600,fontSize:15,cursor:"pointer",textAlign:"center",lineHeight:1.4,transition:"all 0.15s"}}>
                        <div style={{fontSize:17,marginBottom:2}}>{m.icon}</div>
                        <div style={{fontSize:13}}>{m.label}</div>
                      </button>
                    ))}
                  </div>

                  {/* STK Push */}
                  {mpesaSubMethod==="stk"&&<>
                    {mpesaStage==="idle"&&(()=>{
                      const sh={...SHOP_DEFAULTS,...(shopSettingsProp||getShopSettings())};
                      const hasBoth=!!(sh.till&&sh.paybill);
                      const effectiveTarget=stkTarget||(sh.till?"till":"paybill");
                      const displayShortcode=effectiveTarget==="till"?sh.till:sh.paybill;
                      return(<>
                        {/* Destination selector — shown when both till and paybill are configured */}
                        {hasBoth&&<div style={{marginBottom:10}}>
                          <div style={{fontSize:13,color:C.text3,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.04em",fontWeight:500}}>Send payment to</div>
                          <div style={{display:"flex",gap:8}}>
                            {[{id:"till",label:"Buy Goods",code:sh.till},{id:"paybill",label:"Paybill",code:sh.paybill}].map(opt=>(
                              <button key={opt.id} onClick={()=>setStkTarget(opt.id)}
                                style={{flex:1,padding:"9px 10px",borderRadius:8,border:`1.5px solid ${effectiveTarget===opt.id?C.green:C.border}`,background:effectiveTarget===opt.id?"rgba(34,197,94,0.1)":"transparent",color:effectiveTarget===opt.id?C.green:C.text3,cursor:"pointer",transition:"all 0.15s"}}>
                                <div style={{fontWeight:700,fontSize:14}}>{opt.label}</div>
                                <div style={{fontFamily:"'DM Mono',monospace",fontSize:15,marginTop:2,color:effectiveTarget===opt.id?C.green:C.text2}}>{opt.code}</div>
                              </button>
                            ))}
                          </div>
                        </div>}
                        {!hasBoth&&displayShortcode&&<div style={{background:"rgba(34,197,94,0.07)",border:`1px solid ${C.green}25`,borderRadius:8,padding:"8px 12px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span style={{fontSize:15,color:C.text3}}>Sends to</span>
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:600,color:C.green}}>{displayShortcode} <span style={{fontSize:14,color:C.text3}}>({effectiveTarget==="till"?"Till":"Paybill"})</span></span>
                        </div>}
                        <label style={{fontSize:13,color:C.text3,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Safaricom Number</label>
                        <input value={mpesaPhone} onChange={e=>setMpesaPhone(e.target.value)} placeholder="e.g. 0712 345 678"
                          style={{width:"100%",background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"10px 12px",fontSize:18,fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:10,transition:"all 0.15s"}}
                          onFocus={e=>{e.target.style.borderColor=C.green;}} onBlur={e=>{e.target.style.borderColor=C.border;}}
                          onKeyDown={e=>e.key==="Enter"&&handleMpesaPush()}/>
                        {mpesaMsg&&<div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"8px 12px",fontSize:14,color:C.red,marginBottom:8}}>⚠️ {mpesaMsg}</div>}
                        <Btn onClick={handleMpesaPush} style={{width:"100%",justifyContent:"center",padding:12,fontSize:16}} disabled={!mpesaPhone.trim()}>📲 Send STK Push</Btn>
                      </>);
                    })()}
                    {mpesaStage==="pushing"&&<div style={{textAlign:"center",padding:"20px 0"}}>
                      <div style={{width:40,height:40,border:`3px solid ${C.border}`,borderTopColor:C.green,borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 12px"}}/>
                      <div style={{color:C.text2,fontSize:13}}>Sending to {mpesaPhone}…</div>
                    </div>}
                    {(mpesaStage==="waiting"||mpesaStage==="fuliza")&&<div style={{textAlign:"center",padding:"12px 0"}}>
                      <div style={{fontSize:36,marginBottom:8}}>{mpesaStage==="fuliza"?"💳":"📲"}</div>
                      <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>
                        {mpesaStage==="fuliza"?"Insufficient Balance — Fuliza Available":"Waiting for PIN…"}
                      </div>
                      {mpesaStage==="fuliza"?(
                        <div style={{background:"rgba(245,158,11,0.08)",border:`1px solid ${C.amber}33`,borderRadius:10,padding:"10px 14px",marginBottom:10,fontSize:14,color:C.text2,textAlign:"left"}}>
                          <div style={{fontWeight:700,color:C.amber,marginBottom:4}}>📱 Customer has insufficient balance</div>
                          <div style={{lineHeight:1.7}}>
                            They can accept <strong style={{color:C.amber}}>Fuliza M-Pesa</strong> on their phone to borrow and complete the payment.<br/>
                            Still polling — will confirm automatically if they accept Fuliza.
                          </div>
                        </div>
                      ):(
                        <div style={{color:C.text2,fontSize:14,marginBottom:10}}>Sent to <strong style={{color:C.green}}>{mpesaPhone}</strong></div>
                      )}
                      <div style={{display:"flex",gap:5,justifyContent:"center",marginBottom:10}}>
                        {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:mpesaStage==="fuliza"?C.amber:C.green,animation:`pulse 1.2s ease ${i*0.4}s infinite`}}/>)}
                      </div>
                      <button onClick={()=>{clearInterval(mpesaPollRef.current);setMpesaStage("idle");}} style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:13,textDecoration:"underline"}}>Cancel</button>
                    </div>}
                    {mpesaStage==="confirmed"&&<div style={{textAlign:"center",padding:"12px 0"}}><div style={{fontSize:44,marginBottom:6}}>✅</div><div style={{fontWeight:700,fontSize:17,color:C.green}}>Payment Confirmed!</div></div>}
                    {(mpesaStage==="failed"||mpesaStage==="timeout")&&<>
                      <div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"12px 14px",marginBottom:10,textAlign:"center",color:C.red,fontSize:15}}>
                        {mpesaStage==="timeout"
                          ?"⏱ M-Pesa request timed out — but the payment may have gone through!"
                          :mpesaMsg==="Transaction cancelled by customer."
                            ?"❌ Transaction cancelled — the customer pressed Cancel on their phone."
                            :mpesaMsg||"Payment failed"}
                      </div>
                      {mpesaStage==="timeout"&&<>
                        <div style={{background:"rgba(245,158,11,0.08)",border:`1px solid ${C.amber}33`,borderRadius:10,padding:14,marginBottom:10}}>
                          <div style={{fontSize:14,fontWeight:600,color:C.amber,marginBottom:6}}>💡 Did the customer receive an M-Pesa confirmation SMS?</div>
                          <div style={{fontSize:15,color:C.text3,marginBottom:10,lineHeight:1.6}}>If yes, enter the M-Pesa transaction code from their SMS to record this payment.</div>
                          <input
                            value={manualCode}
                            onChange={e=>setManualCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,12))}
                            placeholder="e.g. RHB2K4XYZQ"
                            style={{width:"100%",background:C.bg,border:`1px solid ${C.amber}55`,color:C.amber,borderRadius:8,padding:"10px 12px",fontSize:17,fontFamily:"'DM Mono',monospace",letterSpacing:"0.1em",outline:"none",boxSizing:"border-box",marginBottom:8}}
                          />
                          <Btn onClick={async()=>{
                            if(manualCode.length<6) return;
                            setStkMpesaCode(manualCode);
                            setMpesaStage("confirmed");
                            await finishOrder("mobile");
                          }} style={{width:"100%",justifyContent:"center",background:"linear-gradient(135deg,#22C55E,#16a34a)",color:"#000",fontWeight:700}}>
                            ✅ Confirm Payment · {manualCode||"Enter code above"}
                          </Btn>
                        </div>
                      </>}
                      <Btn variant="ghost" onClick={()=>{setMpesaStage("idle");setMpesaMsg("");setStkMpesaCode("");setManualCode("");}} style={{width:"100%",justifyContent:"center"}}>🔄 Try Again</Btn>
                    </>}
                  </>}

                  {/* Paybill */}
                  {mpesaSubMethod==="paybill"&&<>
                    <div style={{background:C.card,border:`1px solid ${C.blue}25`,borderRadius:10,padding:14,marginBottom:10}}>
                      <div style={{fontSize:14,color:C.blue,fontWeight:700,letterSpacing:"0.08em",marginBottom:10,textTransform:"uppercase"}}>Paybill Details</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"8px 10px"}}>
                          <div style={{fontSize:14,color:C.text3,marginBottom:3}}>Business No.</div>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:18,fontWeight:600,color:C.blue}}>{shop.paybill||"—"}</div>
                        </div>
                        <div style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"8px 10px"}}>
                          <div style={{fontSize:14,color:C.text3,marginBottom:3}}>Account No.</div>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:18,fontWeight:600,color:C.blue}}>{shop.paybillAccount||"POS"}</div>
                        </div>
                      </div>
                    </div>
                    {mpesaStage==="idle"&&<>
                      <div style={{display:"flex",gap:8,marginBottom:8}}>
                        <input value={mpesaPhone} onChange={e=>setMpesaPhone(e.target.value)} placeholder="0712 345 678 (optional)"
                          style={{flex:1,background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"9px 12px",fontSize:15,fontFamily:"'DM Mono',monospace",outline:"none",transition:"all 0.15s"}}
                          onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}
                          onKeyDown={e=>e.key==="Enter"&&mpesaPhone.trim()&&handleMpesaPush()}/>
                        <Btn onClick={handleMpesaPush} disabled={!mpesaPhone.trim()||!shop.paybill} style={{padding:"0 14px",whiteSpace:"nowrap"}}>📲 Push</Btn>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{flex:1,height:1,background:C.border}}/><span style={{fontSize:14,color:C.text3}}>or</span><div style={{flex:1,height:1,background:C.border}}/>
                      </div>
                      <Btn onClick={startC2BSession} variant="ghost" disabled={!shop.paybill} style={{width:"100%",justifyContent:"center"}}>📡 Wait for Direct Payment</Btn>
                    </>}
                    {(mpesaStage==="waiting"||mpesaStage==="confirmed")&&<C2BWaiting stage={mpesaStage} total={total} onCancel={()=>{clearInterval(c2bPollRef.current);setMpesaStage("idle");}}/>}
                    {mpesaStage==="pushing"&&<div style={{textAlign:"center",padding:"16px 0"}}><div style={{width:36,height:36,border:`3px solid ${C.border}`,borderTopColor:C.green,borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 10px"}}/><div style={{color:C.text2,fontSize:13}}>Sending…</div></div>}
                    {mpesaStage==="failed"&&<><div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px",marginBottom:8,textAlign:"center",color:C.red,fontSize:14}}>{mpesaMsg}</div><Btn variant="ghost" onClick={()=>setMpesaStage("idle")} style={{width:"100%",justifyContent:"center"}}>🔄 Try Again</Btn></>}
                  </>}

                  {/* Till */}
                  {mpesaSubMethod==="till"&&<>
                    <div style={{background:C.card,border:`1px solid ${C.blue}25`,borderRadius:10,padding:"10px 14px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div><div style={{fontSize:14,color:C.blue,fontWeight:700,letterSpacing:"0.06em",marginBottom:2,textTransform:"uppercase"}}>Till Number</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:600,color:C.blue}}>{shop.till||"—"}</div></div>
                    </div>
                    {mpesaStage==="idle"&&<>
                      <label style={{fontSize:13,color:C.text3,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Customer Number</label>
                      <input value={mpesaPhone} onChange={e=>setMpesaPhone(e.target.value)} placeholder="e.g. 0712 345 678"
                        style={{width:"100%",background:"#0D1117",border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"10px 12px",fontSize:17,fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:8,transition:"all 0.15s"}}
                        onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}
                        onKeyDown={e=>e.key==="Enter"&&mpesaPhone.trim()&&handleMpesaPush()}/>
                      {mpesaMsg&&<div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"8px 12px",fontSize:14,color:C.red,marginBottom:8}}>⚠️ {mpesaMsg}</div>}
                      <Btn variant="amber" onClick={handleMpesaPush} style={{width:"100%",justifyContent:"center",padding:12}} disabled={!mpesaPhone.trim()||!shop.till}>📲 Send STK Push</Btn>
                      <div style={{display:"flex",alignItems:"center",gap:8,margin:"8px 0"}}><div style={{flex:1,height:1,background:C.border}}/><span style={{fontSize:14,color:C.text3}}>or</span><div style={{flex:1,height:1,background:C.border}}/></div>
                      <Btn onClick={startC2BSession} variant="ghost" disabled={!shop.till} style={{width:"100%",justifyContent:"center"}}>📡 Wait for Direct Payment</Btn>
                    </>}
                    {mpesaStage==="pushing"&&<div style={{textAlign:"center",padding:"16px 0"}}><div style={{width:36,height:36,border:`3px solid ${C.border}`,borderTopColor:C.green,borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 10px"}}/><div style={{color:C.text2,fontSize:13}}>Sending to {mpesaPhone}…</div></div>}
                    {(mpesaStage==="waiting"||mpesaStage==="confirmed")&&<C2BWaiting stage={mpesaStage} total={total} onCancel={()=>{clearInterval(c2bPollRef.current);setMpesaStage("idle");}}/>}
                    {mpesaStage==="failed"&&<><div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px",marginBottom:8,textAlign:"center",color:C.red,fontSize:14}}>{mpesaMsg}</div><Btn variant="ghost" onClick={()=>setMpesaStage("idle")} style={{width:"100%",justifyContent:"center"}}>🔄 Retry</Btn></>}
                  </>}

                  {/* Pochi */}
                  {mpesaSubMethod==="pochi"&&<>
                    <div style={{background:C.card,border:`1px solid ${C.purple}25`,borderRadius:10,padding:14,marginBottom:10,textAlign:"center"}}>
                      <div style={{fontSize:14,color:C.purple,fontWeight:700,letterSpacing:"0.08em",marginBottom:8,textTransform:"uppercase"}}>Pochi la Biashara</div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:600,color:C.purple,marginBottom:4}}>{shop.pochiPhone||shop.phone||"—"}</div>
                    </div>
                    <div style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",fontSize:15,color:C.text2,marginBottom:10}}>Customer: M-Pesa → Send Money → Pochi la Biashara → enter number → confirm PIN.</div>
                    <Btn onClick={()=>finishOrder("mobile")} style={{width:"100%",justifyContent:"center",padding:12}} disabled={payLoading}>{payLoading?"Saving…":"✅ Confirm Receipt"}</Btn>
                  </>}

                  {/* Send Money */}
                  {mpesaSubMethod==="send"&&<>
                    <div style={{background:"rgba(245,158,11,0.07)",border:`1px solid ${C.amber}30`,borderRadius:10,padding:14,marginBottom:10,textAlign:"center"}}>
                      <div style={{fontSize:14,color:C.amber,fontWeight:700,letterSpacing:"0.08em",marginBottom:6,textTransform:"uppercase"}}>Send Money To</div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:600,color:C.amber,marginBottom:2}}>{shop.phone||"—"}</div>
                      <div style={{fontSize:14,color:C.text3}}>{shop.name}</div>
                    </div>
                    <div style={{background:"rgba(245,158,11,0.07)",border:`1px solid ${C.amber}25`,borderRadius:8,padding:"10px 12px",fontSize:15,color:C.text2,marginBottom:10}}>⚠️ Manual confirmation — check your M-Pesa SMS before confirming.</div>
                    <Btn onClick={()=>finishOrder("mobile")} style={{width:"100%",justifyContent:"center",padding:12}} disabled={payLoading}>{payLoading?"Saving…":"✅ Payment Received"}</Btn>
                  </>}
                </>);
              })()}

              {payError&&<div style={{background:C.redGlow,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red,marginTop:10}}>⚠️ {payError}</div>}
              {(payMethod==="Cash"||payMethod==="Card")&&(
                <Btn onClick={processPayment} style={{width:"100%",justifyContent:"center",padding:13,fontSize:16,marginTop:10}}
                  disabled={(payMethod==="Cash"&&cashFloat<total)||payLoading}>
                  {payLoading
                    ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:14,height:14,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Processing…</span>
                    :"✅ Confirm Payment"}
                </Btn>
              )}
            </div>

            {/* RIGHT — Order summary */}
            <div style={{display:"flex",flexDirection:"column",gap:0}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text3,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:10}}>Order Summary</div>

              {/* Customer loyalty strip */}
              {selCust?(
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:10,
                  background:"rgba(34,197,94,0.06)",border:`1px solid ${C.green}33`,marginBottom:10}}>
                  <div style={{width:30,height:30,borderRadius:8,background:"rgba(34,197,94,0.15)",
                    display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:15,color:C.green,flexShrink:0}}>
                    {selCust.name[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:15,color:C.green}}>{selCust.name}</div>
                    <div style={{fontSize:14,color:C.text3}}>
                      ⭐ {selCust.points||0} pts current · +{Math.floor(total/100)} pts this sale
                    </div>
                  </div>
                </div>
              ):(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",borderRadius:10,
                  background:"rgba(245,158,11,0.06)",border:`1px solid ${C.amber}33`,marginBottom:10}}>
                  <span style={{fontSize:17}}>⚠️</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:14,color:C.amber}}>No customer linked</div>
                    <div style={{fontSize:13,color:C.text3}}>Loyalty points won't be tracked for this sale</div>
                  </div>
                  {perms.posCustomerPick&&<button onClick={()=>{setPayModal(false);}}
                    style={{fontSize:13,fontWeight:600,color:C.blue,background:C.blueGlow,border:`1px solid ${C.blue}33`,
                      borderRadius:6,padding:"4px 10px",cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>
                    + Add
                  </button>}
                </div>
              )}
              <div style={{background:"#0D1117",borderRadius:10,border:`1px solid ${C.border}`,overflow:"hidden",marginBottom:12}}>
                <div style={{maxHeight:200,overflowY:"auto"}}>
                  {cart.map((item,i)=>(
                    <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderBottom:i<cart.length-1?`1px solid ${C.border}`:"none"}}>
                      <div style={{width:30,height:30,borderRadius:6,overflow:"hidden",flexShrink:0,background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
                        {item.image?<img src={item.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:item.emoji||"📦"}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.name}</div>
                        <div style={{fontSize:14,color:C.text3}}>×{item.qty} @ KSh {item.price.toLocaleString("en-KE")}</div>
                      </div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:14,color:C.text,flexShrink:0}}>
                        KSh {(item.price*item.qty).toLocaleString("en-KE")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
               {/* ── Delivery toggle ── */}
               <div style={{background:"#0D1117",borderRadius:10,border:`1px solid ${delivery.isDelivery?C.green+"55":C.border}`,padding:"10px 14px",marginBottom:8,transition:"border-color 0.2s"}}>
                 <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                   <div style={{display:"flex",alignItems:"center",gap:7}}>
                     <span style={{fontSize:17}}>🚚</span>
                     <span style={{fontSize:14,fontWeight:600,color:delivery.isDelivery?C.green:C.text2}}>Delivery Order</span>
                   </div>
                   <button onClick={()=>setDelivery(d=>({...d,isDelivery:!d.isDelivery}))}
                     style={{width:42,height:22,borderRadius:11,border:"none",cursor:"pointer",padding:0,
                       background:delivery.isDelivery?C.green:C.border,position:"relative",transition:"background 0.2s",flexShrink:0}}>
                     <span style={{position:"absolute",top:2,left:delivery.isDelivery?21:2,
                       width:18,height:18,borderRadius:"50%",background:"#fff",
                       transition:"left 0.2s",display:"block",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
                   </button>
                 </div>
                  {delivery.isDelivery&&(
                    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
                      {/* Customer name for delivery */}
                      <div style={{fontSize:12,color:C.text3,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:2}}>📋 Customer & Contact</div>
                      <input value={delivery.name||""} onChange={e=>setDelivery(d=>({...d,name:e.target.value}))}
                        placeholder="👤 Customer full name *"
                        style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                          padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                      {/* Phone row */}
                      <div className="r-delivery-row" style={{display:"flex",gap:8}}>
                        <input value={delivery.phone||""} onChange={e=>setDelivery(d=>({...d,phone:e.target.value}))}
                          placeholder="📞 Phone (primary) *"
                          style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                            padding:"8px 10px",fontSize:14,outline:"none",flex:1,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                        <input value={delivery.altPhone||""} onChange={e=>setDelivery(d=>({...d,altPhone:e.target.value}))}
                          placeholder="📞 Alt. phone (optional)"
                          style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                            padding:"8px 10px",fontSize:14,outline:"none",flex:1,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                      </div>
                      {/* Address section */}
                      <div style={{fontSize:12,color:C.text3,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:2,marginTop:4}}>📍 Delivery Address</div>
                      <input value={delivery.address||""} onChange={e=>setDelivery(d=>({...d,address:e.target.value}))}
                        placeholder="🏠 Street / Estate / Building *"
                        style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                          padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                      <div className="r-delivery-row" style={{display:"flex",gap:8}}>
                        <input value={delivery.area||""} onChange={e=>setDelivery(d=>({...d,area:e.target.value}))}
                          placeholder="🌍 Area / Neighbourhood (e.g. Westlands)"
                          style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                            padding:"8px 10px",fontSize:14,outline:"none",flex:1,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                        <input value={delivery.town||""} onChange={e=>setDelivery(d=>({...d,town:e.target.value}))}
                          placeholder="🏙️ Town / City"
                          style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                            padding:"8px 10px",fontSize:14,outline:"none",flex:1,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                      </div>
                      <input value={delivery.landmark||""} onChange={e=>setDelivery(d=>({...d,landmark:e.target.value}))}
                        placeholder="🏁 Landmark — e.g. Near Total Petrol Station (important in Kenya!)"
                        style={{background:C.card,border:`1px solid ${C.amber}44`,color:C.text,borderRadius:7,
                          padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=C.amber} onBlur={e=>e.target.style.borderColor=C.amber+"44"}/>
                      {/* Fee + time row */}
                      <div className="r-delivery-row" style={{display:"flex",gap:8,marginTop:4}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,color:C.text3,marginBottom:3}}>🚚 Delivery Fee (KSh)</div>
                          <input value={delivery.fee||""} onChange={e=>setDelivery(d=>({...d,fee:+e.target.value||0}))}
                            type="number" min="0" placeholder="0"
                            style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                              padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                            onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                        </div>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,color:C.text3,marginBottom:3}}>⏰ Estimated Delivery</div>
                          <input value={delivery.deliveryTime||""} onChange={e=>setDelivery(d=>({...d,deliveryTime:e.target.value}))}
                            placeholder="e.g. Today by 4:00 PM"
                            style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                              padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                            onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                        </div>
                      </div>
                      {/* Notes */}
                      <input value={delivery.notes||""} onChange={e=>setDelivery(d=>({...d,notes:e.target.value}))}
                        placeholder="📝 Delivery notes — e.g. Call on arrival · Leave at gate · Fragile"
                        style={{background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:7,
                          padding:"8px 10px",fontSize:14,outline:"none",width:"100%",boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=C.green} onBlur={e=>e.target.style.borderColor=C.border}/>
                    </div>
                  )}
               </div>
              <div style={{background:"#0D1117",borderRadius:10,border:`1px solid ${C.border}`,padding:"12px 14px",display:"flex",flexDirection:"column",gap:8}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:15,color:C.text3}}>
                  <span>Subtotal</span><span style={{fontFamily:"'DM Mono',monospace",color:C.text2}}>KSh {subtotal.toLocaleString("en-KE",{minimumFractionDigits:2})}</span>
                </div>
                {discountAmt>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:15,color:C.green}}>
                  <span>Discount</span><span style={{fontFamily:"'DM Mono',monospace"}}>−KSh {discountAmt.toLocaleString("en-KE",{minimumFractionDigits:2})}</span>
                </div>}
                 {delivery?.isDelivery&&(delivery.fee||0)>0&&(
                   <div style={{display:"flex",justifyContent:"space-between",fontSize:15,color:C.green}}>
                     <span>🚚 Delivery Fee</span>
                     <span style={{fontFamily:"'DM Mono',monospace"}}>+KSh {Number(delivery.fee).toLocaleString("en-KE",{minimumFractionDigits:2})}</span>
                   </div>
                 )}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:15,color:C.text3}}>
                  <span>VAT (16% incl.)</span><span style={{fontFamily:"'DM Mono',monospace",color:C.text2}}>KSh {tax.toLocaleString("en-KE",{minimumFractionDigits:2})}</span>
                </div>
                <div style={{height:1,background:C.border,margin:"2px 0"}}/>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.text3,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:1}}>Total</div>
                    <div style={{fontSize:13,color:C.text3}}>{selCust?.name||"Walk-in"}</div>
                  </div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:28,fontWeight:500,color:C.green,letterSpacing:"-0.03em"}}>
                    KSh {total.toLocaleString("en-KE",{minimumFractionDigits:2})}
                  </div>
                </div>
              </div>

              {/* ── COD / Paid Banner ── */}
              {delivery?.isDelivery&&payMethod==="Cash"&&(
                <div style={{marginTop:10,background:"rgba(202,138,4,0.12)",border:"3px solid #ca8a04",borderRadius:10,padding:"14px 16px",textAlign:"center"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#92400e",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:4}}>💵 COLLECT ON DELIVERY</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:800,color:"#92400e",letterSpacing:"-0.02em"}}>
                    KSh {total.toLocaleString("en-KE",{minimumFractionDigits:2})}
                  </div>
                  <div style={{fontSize:12,color:"#92400e",marginTop:4,opacity:0.8}}>Rider must collect this exact amount in cash</div>
                </div>
              )}
              {delivery?.isDelivery&&payMethod!=="Cash"&&(
                <div style={{marginTop:10,background:"rgba(34,197,94,0.1)",border:"2px solid #16a34a",borderRadius:10,padding:"12px 16px",textAlign:"center"}}>
                  <div style={{fontSize:14,fontWeight:800,color:"#15803d",letterSpacing:"0.08em",textTransform:"uppercase"}}>✅ PAID — {payMethod.toUpperCase()}</div>
                  <div style={{fontSize:12,color:"#166534",marginTop:3}}>No cash collection required from rider</div>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ══════════ RECEIPT MODAL ══════════ */}
      {receiptModal&&(()=>{
        const shop={...SHOP_DEFAULTS,...(shopSettingsProp||getShopSettings())};
        const rDel=receiptModal.delivery||null;
        const isDelOrder=!!(rDel?.isDelivery);
        const delFee=isDelOrder?(Number(rDel.fee)||0):0;
        const isCOD=isDelOrder&&receiptModal.method==="Cash";
        const isPaidDelivery=isDelOrder&&receiptModal.method!=="Cash";
        return(
        <Modal title={receiptModal.offline?"Receipt (Offline — will sync)":isDelOrder?"🚚 Delivery Receipt":"Receipt"} onClose={()=>setReceiptModal(null)}>
          <div style={{background:"#0D1117",borderRadius:10,padding:16,fontFamily:"'DM Mono',monospace",fontSize:14}}>
            <div style={{textAlign:"center",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"center",marginBottom:6}}>
                <img src="/starmart_icon.png" alt="" style={{width:48,height:48,borderRadius:12,objectFit:"cover"}}/>
              </div>
              <div style={{fontFamily:"'Inter',sans-serif",fontWeight:800,fontSize:18,color:C.green,marginBottom:2}}>{shop.name}</div>
              <div style={{color:C.text3,fontSize:10}}>{shop.address}</div>
              {shop.phone&&<div style={{color:C.text3,fontSize:10}}>Tel: {shop.phone}</div>}
              {shop.email&&<div style={{color:C.text3,fontSize:10}}>{shop.email}</div>}
              <div style={{height:1,background:C.border,margin:"10px 0"}}/>
              <div style={{fontSize:14,color:C.text2}}>{receiptModal.date}</div>
              <div style={{fontSize:14,color:C.text2}}>Order {receiptModal.id} · {receiptModal.customer}</div>
            </div>

            {/* ── DELIVERY ORDER BANNER ── */}
            {isDelOrder&&(
              <div style={{background:"rgba(34,197,94,0.07)",border:`2px solid ${C.green}55`,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                <div style={{fontWeight:800,fontSize:13,color:C.green,textAlign:"center",letterSpacing:"0.08em",marginBottom:8}}>
                  🚚 DELIVERY ORDER
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4,fontSize:12}}>
                  {rDel.name&&<div style={{display:"flex",gap:6}}><span style={{color:C.text3,minWidth:60}}>Customer:</span><span style={{color:C.text,fontWeight:600}}>{rDel.name}</span></div>}
                  {rDel.phone&&<div style={{display:"flex",gap:6}}><span style={{color:C.text3,minWidth:60}}>Phone:</span><span style={{color:C.text}}>{rDel.phone}{rDel.altPhone?` / ${rDel.altPhone}`:""}</span></div>}
                  {rDel.address&&<div style={{display:"flex",gap:6}}><span style={{color:C.text3,minWidth:60}}>Address:</span><span style={{color:C.text}}>{[rDel.address,rDel.area,rDel.town].filter(Boolean).join(", ")}</span></div>}
                  {rDel.landmark&&<div style={{display:"flex",gap:6}}><span style={{color:C.amber,minWidth:60}}>Landmark:</span><span style={{color:C.amber,fontWeight:600}}>{rDel.landmark}</span></div>}
                  {rDel.deliveryTime&&<div style={{display:"flex",gap:6}}><span style={{color:C.text3,minWidth:60}}>Expected:</span><span style={{color:C.blue}}>{rDel.deliveryTime}</span></div>}
                  {rDel.notes&&<div style={{display:"flex",gap:6}}><span style={{color:C.text3,minWidth:60}}>Notes:</span><span style={{color:C.text3,fontStyle:"italic"}}>{rDel.notes}</span></div>}
                </div>
              </div>
            )}

            <div style={{height:1,background:C.border,margin:"8px 0"}}/>
            {receiptModal.items.map((item,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:15}}>
                <span style={{color:C.text2}}>{item.emoji||""} {item.name} ×{item.qty}</span>
                <span>{ksh(item.price*item.qty)}</span>
              </div>
            ))}
            <div style={{height:1,background:C.border,margin:"8px 0"}}/>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3,color:C.text3,fontSize:13}}><span>Subtotal</span><span>{ksh(receiptModal.subtotal)}</span></div>
            {receiptModal.discount>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:3,color:C.green,fontSize:13}}><span>Discount</span><span>−{ksh(receiptModal.discount)}</span></div>}
            {delFee>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:3,color:C.green,fontSize:13}}><span>🚚 Delivery Fee</span><span>+{ksh(delFee)}</span></div>}
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8,color:C.text3,fontSize:13}}><span>VAT (16% incl.)</span><span>{ksh(receiptModal.tax)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:`1px solid ${C.border}`}}>
              <span style={{fontSize:15,fontWeight:600,fontFamily:"'Inter',sans-serif"}}>TOTAL</span>
              <span style={{fontSize:20,fontWeight:500,color:C.green,letterSpacing:"-0.02em"}}>{ksh(receiptModal.total)}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6,color:C.text3,fontSize:13}}><span>Payment</span><span>{receiptModal.method}</span></div>
            {receiptModal.method==="Cash"&&receiptModal.cash>0&&!isDelOrder&&<>
              <div style={{display:"flex",justifyContent:"space-between",color:C.text3,fontSize:13}}><span>Cash</span><span>{ksh(receiptModal.cash)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",color:C.green,fontSize:13}}><span>Change</span><span>{ksh(receiptModal.cash-receiptModal.total)}</span></div>
            </>}

            {/* ── COD BANNER — Cash on Delivery ── */}
            {isCOD&&(
              <div style={{background:"rgba(202,138,4,0.12)",border:"3px solid #ca8a04",borderRadius:10,
                padding:"12px 14px",marginTop:10,textAlign:"center"}}>
                <div style={{fontSize:11,fontWeight:800,color:"#92400e",letterSpacing:"0.1em",marginBottom:4}}>
                  💵 COLLECT ON DELIVERY
                </div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:900,color:"#92400e",letterSpacing:"-0.02em"}}>
                  {ksh(receiptModal.total)}
                </div>
                <div style={{fontSize:11,color:"#b45309",marginTop:4,fontWeight:600}}>
                  Rider must collect this exact amount in cash
                </div>
              </div>
            )}

            {/* ── PAID DELIVERY BANNER ── */}
            {isPaidDelivery&&(
              <div style={{background:"rgba(34,197,94,0.1)",border:`2px solid ${C.green}55`,borderRadius:10,
                padding:"10px 14px",marginTop:10,textAlign:"center"}}>
                <div style={{fontSize:13,fontWeight:800,color:C.green,letterSpacing:"0.06em"}}>
                  ✅ PAID — {receiptModal.method.toUpperCase()}
                </div>
                <div style={{fontSize:11,color:"#16a34a",marginTop:3}}>No cash collection required</div>
              </div>
            )}

            {/* Customer loyalty summary */}
            {receiptModal.custName&&(
              <div style={{background:"rgba(34,197,94,0.06)",border:`1px solid ${C.green}33`,
                borderRadius:8,padding:"10px 12px",marginTop:8,textAlign:"center"}}>
                <div style={{fontSize:15,fontWeight:700,color:C.green}}>👤 {receiptModal.custName}</div>
                <div style={{marginTop:8,background:"rgba(255,255,255,0.03)",borderRadius:8,
                  padding:"8px 10px",fontSize:14,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",justifyContent:"space-between",color:C.text3}}>
                    <span>Points before</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontWeight:600,color:C.text2}}>{(receiptModal.initialPoints||0).toLocaleString()} pts</span>
                  </div>
                  {(receiptModal.pointsRedeemed||0)>0&&(
                    <div style={{display:"flex",justifyContent:"space-between",color:C.amber}}>
                      <span>Redeemed</span>
                      <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>−{receiptModal.pointsRedeemed} pts</span>
                    </div>
                  )}
                  <div style={{display:"flex",justifyContent:"space-between",color:C.green}}>
                    <span>Earned this sale</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>+{receiptModal.pointsEarned||0} pts</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",paddingTop:4,
                    borderTop:`1px dashed ${C.border}`,marginTop:2}}>
                    <span style={{fontWeight:700,color:C.text}}>New balance</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.green,fontSize:16}}>
                      {((receiptModal.initialPoints||0)-(receiptModal.pointsRedeemed||0)+(receiptModal.pointsEarned||0)).toLocaleString()} pts ⭐
                    </span>
                  </div>
                </div>
              </div>
            )}
            {/* COD / PAID banner */}
            {isCOD&&(
              <div style={{background:"rgba(202,138,4,0.15)",border:"3px solid #ca8a04",borderRadius:10,
                padding:"14px 16px",marginTop:10,textAlign:"center"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#92400e",letterSpacing:"0.1em",
                  textTransform:"uppercase",marginBottom:6}}>💵 COLLECT ON DELIVERY</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:24,fontWeight:800,
                  color:"#92400e",letterSpacing:"-0.02em"}}>
                  {ksh(receiptModal.total)}
                </div>
                <div style={{fontSize:11,color:"#92400e",marginTop:4,opacity:0.8}}>
                  Rider must collect this exact amount in cash
                </div>
              </div>
            )}
            {isPaidDelivery&&(
              <div style={{background:"rgba(34,197,94,0.1)",border:"2px solid #16a34a",borderRadius:10,
                padding:"12px 16px",marginTop:10,textAlign:"center"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#15803d",letterSpacing:"0.08em",textTransform:"uppercase"}}>
                  ✅ PAID — {receiptModal.method.toUpperCase()}
                </div>
                <div style={{fontSize:11,color:"#166534",marginTop:3}}>No cash collection required from rider</div>
              </div>
            )}
            {!receiptModal.custName&&!isDelOrder&&(
              <div style={{background:"rgba(245,158,11,0.06)",border:`1px solid ${C.amber}33`,
                borderRadius:8,padding:"8px 12px",marginTop:8,textAlign:"center",fontSize:13,color:C.amber}}>
                Walk-in sale — no loyalty points tracked
              </div>
            )}
            <div style={{height:1,background:C.border,margin:"10px 0"}}/>
            <div style={{textAlign:"center",color:C.text3,fontSize:10}}>{shop.thankYou}</div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <Btn onClick={()=>printReceipt(receiptModal)} style={{flex:1,justifyContent:"center"}} variant="ghost">🖨️ Print Receipt</Btn>
            <Btn onClick={()=>setReceiptModal(null)} style={{flex:1,justifyContent:"center"}}>Done</Btn>
          </div>
        </Modal>
      );})()}
    </div>
  );
}

/* ══════════ BARCODE MODAL (extracted to avoid hooks-in-IIFE violation) ══════════ */
function BarcodeModal({product,onClose,fetchProducts}){
  const [editBarcode,setEditBarcode]=useState(product.barcode||"");
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [labelSize,setLabelSize]=useState("60x40");

  // Real-time display: show typed value, or SKU if blank
  const displayVal = editBarcode.trim() || product.sku;
  const isUsingSku = !editBarcode.trim();

  // Detect format for info badge
  const digits = displayVal.replace(/\D/g,"");
  const formatLabel = digits.length===13?"EAN-13":digits.length===8?"EAN-8":digits.length===12?"UPC-A":"Code128";

  const LABEL_SIZES = [
    {id:"60x40",  label:"60 × 40 mm",  desc:"Standard shelf label"},
    {id:"50x30",  label:"50 × 30 mm",  desc:"Medium thermal roll"},
    {id:"38x25",  label:"38 × 25 mm",  desc:"Small item label"},
    {id:"100x50", label:"100 × 50 mm", desc:"Large price tag"},
  ];

  const handleSaveBarcode=async()=>{
    setSaving(true);
    try{
      const r=await apiFetch(`/api/products/${product.id}`,{method:"PATCH",body:JSON.stringify({barcode:editBarcode.trim()||null})});
      if(r.ok){ setSaved(true); fetchProducts(); setTimeout(()=>setSaved(false),2500); }
    }catch(e){console.error("Barcode save error:",e.message);}
    setSaving(false);
  };

  const selectedSize = LABEL_SIZES.find(s=>s.id===labelSize)||LABEL_SIZES[0];

  return(
    <Modal title="Product Barcode" onClose={onClose}>
      {/* Product header */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 0 16px",borderBottom:`1px solid ${C.border}`}}>
        {product.image
          ?<img src={product.image} alt="" style={{width:52,height:52,borderRadius:10,objectFit:"cover",flexShrink:0}}/>
          :<div style={{width:52,height:52,borderRadius:10,background:"rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0}}>{product.emoji||"📦"}</div>}
        <div>
          <div style={{fontWeight:700,fontSize:16}}>{product.name}</div>
          <div style={{color:C.text3,fontSize:14,marginTop:2}}>{product.sku} · {ksh(product.price)}</div>
        </div>
      </div>

      {/* Barcode input with real-time preview */}
      <div style={{marginTop:16,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase"}}>
            🔲 Barcode Number
          </label>
          <span style={{fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:20,
            background:C.blue+"18",color:C.blue,fontFamily:"'DM Mono',monospace"}}>
            {formatLabel}
          </span>
        </div>
        <Input
          value={editBarcode}
          onChange={e=>setEditBarcode(e.target.value)}
          placeholder={`Leave blank to use SKU: ${product.sku}`}
          style={{fontFamily:"'DM Mono',monospace",fontSize:16,textAlign:"center"}}
          autoFocus
        />
        {/* SKU fallback notice */}
        {isUsingSku&&(
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6,fontSize:13,color:C.amber}}>
            <span>⚡</span>
            <span>Using SKU <strong style={{fontFamily:"'DM Mono',monospace"}}>{product.sku}</strong> as barcode — type a number above to override</span>
          </div>
        )}
        {!isUsingSku&&(
          <div style={{fontSize:13,color:C.green,marginTop:6}}>
            ✓ Custom barcode set · will be saved to this product
          </div>
        )}
      </div>

      {/* Live barcode preview */}
      <div style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${C.border}`,
        borderRadius:10,padding:"16px 12px",marginBottom:14,textAlign:"center"}}>
        <div style={{fontSize:12,color:C.text3,marginBottom:10,textTransform:"uppercase",
          letterSpacing:"0.06em",fontWeight:600}}>Live Preview</div>
        <div style={{display:"flex",justifyContent:"center"}}>
          <BarcodeDisplay key={labelSize} value={displayVal} width={labelSize==="38x25"?180:labelSize==="50x30"?210:labelSize==="100x50"?320:260} height={labelSize==="38x25"?60:labelSize==="50x30"?70:labelSize==="100x50"?100:85}/>
        </div>
        <div style={{fontSize:12,color:C.text3,marginTop:8}}>
          {isUsingSku ? "Showing SKU as barcode" : `Barcode: ${displayVal}`}
        </div>
      </div>

      {/* Label size selector */}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
          textTransform:"uppercase",display:"block",marginBottom:8}}>
          🖨️ Label Size
        </label>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {LABEL_SIZES.map(s=>(
            <button key={s.id} onClick={()=>setLabelSize(s.id)}
              style={{padding:"6px 12px",borderRadius:8,cursor:"pointer",transition:"all 0.15s",
                border:`1px solid ${labelSize===s.id?C.blue:C.border}`,
                background:labelSize===s.id?C.blueGlow:"transparent",
                color:labelSize===s.id?C.blue:C.text2,textAlign:"left"}}>
              <div style={{fontSize:13,fontWeight:700}}>{s.label}</div>
              <div style={{fontSize:11,opacity:0.7,marginTop:1}}>{s.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {saved&&<div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:8,
        padding:"8px 12px",fontSize:14,color:C.green,marginBottom:10,textAlign:"center"}}>
        ✅ Barcode saved!
      </div>}

      <div style={{display:"flex",gap:8}}>
        <Btn onClick={handleSaveBarcode} disabled={saving} style={{flex:1,justifyContent:"center"}}>
          {saving?"Saving…":"💾 Save Barcode"}
        </Btn>
        <Btn onClick={()=>printBarcode({...product,barcode:displayVal},1,selectedSize.id)}
          style={{flex:1,justifyContent:"center"}} variant="ghost">
          🖨️ Print Label
        </Btn>
      </div>
    </Modal>
  );
}

/* ══════════ RECEIVE STOCK MODAL ══════════ */
function ReceiveStockModal({product, onClose, onSave}){
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const handleSave = async () => {
    if(qty < 1) return;
    setSaving(true);
    await onSave(qty, note);
    setSaving(false);
  };

  return(
    <Modal title="📦 Receive Stock" onClose={onClose}>
      {/* Product info */}
      <div style={{display:"flex",alignItems:"center",gap:14,padding:"12px 14px",
        background:"rgba(255,255,255,0.03)",borderRadius:10,marginBottom:20,
        border:`1px solid ${C.border}`}}>
        <div style={{width:52,height:52,borderRadius:10,overflow:"hidden",flexShrink:0,
          background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:26}}>
          {product.image
            ?<img src={product.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            :product.emoji||"📦"}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:16}}>{product.name}</div>
          <div style={{fontSize:13,color:C.text3,fontFamily:"DM Mono,monospace",marginTop:2}}>
            {product.sku} · {product.cat}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
            <span style={{fontSize:13,color:C.text3}}>Current stock:</span>
            <span style={{fontFamily:"DM Mono,monospace",fontWeight:700,fontSize:15,
              color:product.stock<=0?C.red:product.stock<5?C.amber:C.green}}>
              {product.stock} units
            </span>
          </div>
        </div>
      </div>

      {/* Quantity to receive */}
      <div style={{marginBottom:18}}>
        <label style={{fontSize:13,color:C.text2,fontWeight:600,textTransform:"uppercase",
          letterSpacing:"0.06em",display:"block",marginBottom:10}}>
          How many units are you receiving?
        </label>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
          <button onClick={()=>setQty(q=>Math.max(1,q-1))}
            style={{width:44,height:44,borderRadius:10,border:`1px solid ${C.border}`,
              background:"transparent",color:C.text,cursor:"pointer",fontSize:22,fontWeight:600}}>−</button>
          <input type="number" min="1" value={qty}
            onChange={e=>setQty(Math.max(1,parseInt(e.target.value)||1))}
            style={{flex:1,background:"#0D1117",border:`1.5px solid ${C.blue}55`,
              color:C.blue,borderRadius:10,padding:"10px 14px",fontSize:28,
              fontFamily:"DM Mono,monospace",textAlign:"center",outline:"none",fontWeight:700}}
          />
          <button onClick={()=>setQty(q=>q+1)}
            style={{width:44,height:44,borderRadius:10,border:`1px solid ${C.border}`,
              background:"transparent",color:C.text,cursor:"pointer",fontSize:22,fontWeight:600}}>+</button>
        </div>
        {/* Quick qty presets */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {[5,10,12,24,48,100].map(v=>(
            <button key={v} onClick={()=>setQty(v)}
              style={{padding:"5px 14px",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600,
                border:`1px solid ${qty===v?C.blue:C.border}`,
                background:qty===v?"rgba(99,102,241,0.12)":"transparent",
                color:qty===v?C.blue:C.text2,transition:"all 0.15s"}}>
              +{v}
            </button>
          ))}
        </div>
      </div>

      {/* New stock preview */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        padding:"12px 16px",borderRadius:10,marginBottom:16,
        background:"rgba(34,197,94,0.08)",border:`1px solid ${C.green}44`}}>
        <div>
          <div style={{fontSize:13,color:C.text3}}>New stock after receiving</div>
          <div style={{fontFamily:"DM Mono,monospace",fontSize:26,fontWeight:800,color:C.green,marginTop:2}}>
            {product.stock + qty} units
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:13,color:C.text3}}>Adding</div>
          <div style={{fontFamily:"DM Mono,monospace",fontSize:22,fontWeight:700,color:C.blue}}>
            +{qty}
          </div>
        </div>
      </div>

      {/* Optional note */}
      <div style={{marginBottom:18}}>
        <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:6}}>
          📝 Note (optional — e.g. supplier name, invoice #)
        </label>
        <input value={note} onChange={e=>setNote(e.target.value)}
          placeholder="e.g. Received from ABC Supplier, Invoice #1234"
          style={{width:"100%",background:"#0D1117",border:`1px solid ${C.border}`,
            color:C.text,borderRadius:8,padding:"9px 12px",fontSize:14,outline:"none",
            boxSizing:"border-box"}}
          onFocus={e=>e.target.style.borderColor=C.blue}
          onBlur={e=>e.target.style.borderColor=C.border}
        />
      </div>

      <div style={{display:"flex",gap:8}}>
        <Btn variant="ghost" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={saving||qty<1} style={{flex:2,justifyContent:"center",
          background:"linear-gradient(135deg,#22C55E,#16a34a)",color:"#000",fontWeight:700}}>
          {saving
            ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:14,height:14,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Saving…</span>
            :`✅ Receive +${qty} Units`}
        </Btn>
      </div>
    </Modal>
  );
}

/* ══════════ INVENTORY VIEW (Real DB + Images) ══════════ */

function InventoryView({products,perms,fetchProducts,branches,activeBranch,pendingTransfers,setPendingTransfers,fetchPendingTransfers,shopSettings:invShopSettings,externalScanOpen,onExternalScanClose}){
  const [search,setSearch]=useState("");
  const [catFilter,setCatFilter]=useState("All");
  const [barcodeModal,setBarcodeModal]=useState(null);
  const [addModal,setAddModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  // ── Barcode scanner for inventory receiving ───────────────────────────────
  const [scanInput,setScanInput]=useState("");
  const [scanModalOpen,setScanModalOpen]=useState(false);
  // Sync external open trigger from header button
  useEffect(()=>{
    if(externalScanOpen){ setScanModalOpen(true); if(onExternalScanClose) onExternalScanClose(); }
  },[externalScanOpen]);
  const [scanReceiveModal,setScanReceiveModal]=useState(null);
  const [scanToast,setScanToast]=useState(null);
  const invScanRef=useRef(null);
  const invScanBuffer=useRef("");
  const invScanTimer=useRef(null);
  const [saving,setSaving]=useState(false);
  const [formError,setFormError]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [transferModal,setTransferModal]=useState(null); // product to transfer
  const [branchStockModal,setBranchStockModal]=useState(null); // product to set branch stock
  const [transferToast,setTransferToast]=useState(null);
  const [approvingId,setApprovingId]=useState(null);

  const handleApprove=async(id)=>{
    setApprovingId(id);
    // Optimistic: remove from pending list immediately so it doesn't show as "pending" while waiting
    setPendingTransfers(prev=>prev.filter(t=>t.id!==id));
    try{
      const r=await apiFetch(`/api/branches/transfer/${id}/approve`,{method:"POST"});
      const data=await r.json();
      if(r.ok){
        setTransferToast(data.message);
        setTimeout(()=>setTransferToast(null),4500);
        fetchProducts();          // update stock numbers immediately
        fetchPendingTransfers();  // sync from server to confirm
      } else {
        // Roll back — put it back in list
        fetchPendingTransfers();
        setTransferToast("⚠️ "+data.error);
        setTimeout(()=>setTransferToast(null),4500);
      }
    }catch{
      fetchPendingTransfers();
      setTransferToast("⚠️ Cannot connect.");
      setTimeout(()=>setTransferToast(null),4500);
    }
    setApprovingId(null);
  };

  const handleReject=async(id)=>{
    setApprovingId(id);
    // Optimistic: remove from pending list immediately
    setPendingTransfers(prev=>prev.filter(t=>t.id!==id));
    try{
      const r=await apiFetch(`/api/branches/transfer/${id}/reject`,{method:"POST"});
      const data=await r.json();
      if(r.ok){
        setTransferToast("Transfer rejected.");
        setTimeout(()=>setTransferToast(null),4500);
        fetchPendingTransfers();
      } else {
        fetchPendingTransfers();
        setTransferToast("⚠️ "+data.error);
        setTimeout(()=>setTransferToast(null),4500);
      }
    }catch{
      fetchPendingTransfers();
      setTransferToast("⚠️ Cannot connect.");
      setTimeout(()=>setTransferToast(null),4500);
    }
    setApprovingId(null);
  };

  if(!perms.inventoryView) return <LockedBanner reason="You don't have permission to view inventory. Contact your administrator."/>;


  const filtered=products.filter(p=>{
    const matchCat = catFilter==="All" || p.cat===catFilter;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });
  const totalVal=products.reduce((s,p)=>s+p.stock*p.price,0);
  const LOW_STOCK_THRESHOLD = parseInt((invShopSettings||getShopSettings()).lowStockThreshold)||5;
  const lowStock=products.filter(p=>p.stock<LOW_STOCK_THRESHOLD).length;

  // ── Hardware barcode scanner listener (inventory receiving) ──────────────
  // Scanners type very fast then send Enter — we detect by keystroke speed
  useEffect(()=>{
    const SCAN_SPEED = 50; // ms — faster than human typing
    let lastKey = 0;
    const onKey = (e) => {
      const now = Date.now();
      const fast = (now - lastKey) < SCAN_SPEED;
      lastKey = now;

      if(e.key === "Enter"){
        const buf = invScanBuffer.current.trim();
        if(buf.length >= 3){
          // If scan modal is open, let its own handler deal with it
          if(scanModalOpen) { invScanBuffer.current = ""; return; }
          // Find product
          const found = products.find(p=>
            p.barcode === buf || p.sku === buf ||
            p.barcode?.toLowerCase() === buf.toLowerCase() ||
            p.sku?.toLowerCase() === buf.toLowerCase()
          );
          if(found){
            setScanReceiveModal({product:found, isNew:false, barcode:buf});
          } else {
            setScanReceiveModal({product:null, isNew:true, barcode:buf});
          }
          setScanInput("");
        }
        invScanBuffer.current = "";
        return;
      }

      if(e.key.length === 1 && (fast || invScanBuffer.current.length > 0)){
        invScanBuffer.current += e.key;
        if(invScanTimer.current) clearTimeout(invScanTimer.current);
        invScanTimer.current = setTimeout(()=>{ invScanBuffer.current = ""; }, 100);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [products]);

  // ── Export low-stock items as CSV ────────────────────────────────────────
  const exportLowStock = () => {
    const low = products
      .filter(p => p.stock < LOW_STOCK_THRESHOLD)
      .sort((a, b) => a.stock - b.stock); // most critical first

    if (!low.length) {
      alert('✅ No low stock items right now! All products are well stocked.');
      return;
    }

    const shopName = (getShopSettings().name || 'STARMART').toUpperCase();
    const date = new Date().toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' });
    const time = new Date().toLocaleTimeString('en-KE', { hour:'2-digit', minute:'2-digit' });

    // Build CSV
    const rows = [
      [`${shopName} — Low Stock Report`],
      [`Generated: ${date} at ${time}`],
      [`Threshold: Items with fewer than ${LOW_STOCK_THRESHOLD} units`],
      [],
      ['#', 'Product Name', 'SKU', 'Category', 'Current Stock', 'Unit Price (KSh)', 'Stock Value (KSh)', 'Status'],
      ...low.map((p, i) => [
        i + 1,
        p.name,
        p.sku,
        p.cat,
        p.stock,
        p.price.toFixed(2),
        (p.stock * p.price).toFixed(2),
        p.stock === 0 ? 'OUT OF STOCK' : `LOW (${p.stock} left)`,
      ]),
      [],
      [`Total low-stock items: ${low.length}`],
      [`Total out-of-stock: ${low.filter(p => p.stock === 0).length}`],
    ];

    const csv = rows.map(r => r.map(cell => '"' + String(cell ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `low-stock-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Handle barcode scan in inventory ─────────────────────────────────────
  const handleInvScan = (code) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    // Always close the scan input modal first
    setScanModalOpen(false);
    setScanInput("");
    // Search by barcode first, then SKU
    const found =
      products.find(p => p.barcode === trimmed) ||
      products.find(p => p.sku === trimmed) ||
      products.find(p => p.barcode && p.barcode.toLowerCase() === trimmed.toLowerCase()) ||
      products.find(p => p.sku.toLowerCase() === trimmed.toLowerCase());

    if (found) {
      setScanReceiveModal({ product: found, isNew: false, barcode: trimmed });
    } else {
      // Unknown barcode — open add form pre-filled with barcode
      setScanReceiveModal({ product: null, isNew: true, barcode: trimmed });
    }
  };

  const allCats=["All",...new Set(products.map(p=>p.cat).filter(Boolean))];

  const handleAdd = async (form) => {
    if(!form.name||!form.price||!form.stock){setFormError("Name, price and stock are required.");return;}
    // Resolve category — use custom input when "Other" selected
    const resolvedCat = (form.cat==="Other" && form.customCat?.trim())
      ? form.customCat.trim()
      : form.cat;
    if(form.cat==="Other" && !form.customCat?.trim()){
      setFormError("Please enter a custom category name.");return;
    }
    // Auto-generate SKU if blank
    const words = form.name.trim().toUpperCase().split(/\s+/);
    const prefix = words.length>=2 ? words.slice(0,2).map(w=>w.slice(0,2)).join("") : words[0].slice(0,4);
    const sku = form.sku?.trim() || `${prefix}-${Math.floor(1000+Math.random()*9000)}`;
    setSaving(true);setFormError("");
    try{
      const res=await apiFetch("/api/products",{
        method:"POST",
        body:JSON.stringify({name:form.name,sku:sku,price:+form.price,stock:+form.stock,emoji:form.emoji||"📦",image:form.image||null,categoryName:resolvedCat,barcode:form.barcode||null}),
      });
      const data=await res.json();
      if(!res.ok){setFormError(data.error||"Failed to add product.");}
      else{
        // If a branch is active, create the BranchProduct row for this branch too
        if(activeBranch?.id && data.id){
          await apiFetch(`/api/branches/${activeBranch.id}/stock/${data.id}`,{
            method:"PUT",
            body:JSON.stringify({stock:+form.stock}),
          }).catch(()=>{});
        }
        // Fetch fresh list then close modal — product will be visible immediately
        await fetchProducts(undefined, { skipCache: true });
        setAddModal(false);
      }
    }catch(err){setFormError(err?.message||"Cannot connect to server.");}
    setSaving(false);
  };

  const handleEdit = async (form) => {
    if(!form.name||!form.price){setFormError("Name and price are required.");return;}
    const resolvedCat = (form.cat==="Other" && form.customCat?.trim())
      ? form.customCat.trim()
      : form.cat;
    if(form.cat==="Other" && !form.customCat?.trim()){
      setFormError("Please enter a custom category name.");return;
    }
    setSaving(true);setFormError("");
    try{
      // Always include branchId so the backend updates both Product.stock (global)
      // AND the BranchProduct row for this branch — fixing the "edit doesn't reflect" bug
      const branchId = activeBranch?.id || null;
      const body=perms.inventoryAdd
        ?{name:form.name,sku:form.sku,price:+form.price,stock:+form.stock,emoji:form.emoji,image:form.image??null,categoryName:resolvedCat,barcode:form.barcode||null,branchId}
        :{price:+form.price,stock:+form.stock,branchId};
      const res=await apiFetch(`/api/products/${editModal.id}`,{
        method:"PATCH",
        body:JSON.stringify(body),
      });
      const data=await res.json();
      if(!res.ok){setFormError(data.error||"Failed to update product.");}
      else{await fetchProducts(undefined, { skipCache: true });setEditModal(null);}
    }catch{setFormError("Cannot connect to server.");}
    setSaving(false);
  };

  const handleDelete = async (id) => {
    try{
      await apiFetch(`/api/products/${id}`,{method:"DELETE"});
      // Remove from IDB cache immediately so refresh doesn't restore it
      await idbDelete("products", id).catch(()=>{});
      await fetchProducts(undefined, { skipCache: true });
    }catch{alert("Failed to delete product.");}
    setDeleteConfirm(null);
  };

  return(
    <div style={{padding:"12px 10px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>
      {/* Stats row */}
      <div className="r-grid-stats" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
        {[{label:"Total Products",val:products.length,icon:"📦",color:C.blue},{label:"Low Stock Items",val:lowStock,icon:"⚠️",color:C.red},{label:"Inventory Value",val:`KSh ${totalVal.toLocaleString("en-KE",{maximumFractionDigits:0})}`,icon:"💰",color:C.amber}].map(s=>(
          <Card key={s.label} style={{display:"flex",alignItems:"center",gap:12,padding:16}}><div style={{fontSize:26}}>{s.icon}</div><div><div style={{fontFamily:"DM Mono,monospace",fontSize:18,fontWeight:700,color:s.color}}>{s.val}</div><div style={{fontSize:13,color:C.text3}}>{s.label}</div></div></Card>
        ))}
        {/* Receive Stock card — 4th stat card, always renders */}
        <Card
          onClick={()=>setScanModalOpen(true)}
          style={{display:"flex",alignItems:"center",gap:12,padding:16,
            cursor:"pointer",border:`2px solid ${C.green}44`,
            background:`rgba(34,197,94,0.08)`,transition:"all 0.15s"}}
          hover={true}
        >
          <div style={{width:40,height:40,borderRadius:10,background:`rgba(34,197,94,0.2)`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>📷</div>
          <div>
            <div style={{fontFamily:"DM Mono,monospace",fontSize:16,fontWeight:700,color:C.green}}>Receive</div>
            <div style={{fontSize:13,color:C.text3}}>Scan to add stock</div>
          </div>
        </Card>
      </div>

                        {/* ── Receive Stock Modal ── */}
      {scanModalOpen&&(
        <Modal title="📷 Receive Stock via Barcode" onClose={()=>{setScanModalOpen(false);setScanInput("");}}>
          <div style={{marginBottom:16,fontSize:15,color:C.text2,lineHeight:1.6}}>
            Point your barcode scanner at any product, or type a barcode/SKU manually.
            <br/>The system will find the product and let you add stock.
          </div>
          <div style={{position:"relative",marginBottom:8}}>
            <input
              ref={invScanRef}
              value={scanInput}
              onChange={e=>setScanInput(e.target.value)}
              onKeyDown={e=>{
                if(e.key==="Enter"&&scanInput.trim()){
                  const val = scanInput.trim();
                  setScanModalOpen(false);
                  setScanInput("");
                  setTimeout(()=>handleInvScan(val), 50);
                }
              }}
              placeholder="Scan barcode or type SKU and press Enter…"
              autoFocus
              style={{
                width:"100%",background:"#0D1117",
                border:`2px solid ${C.green}`,
                borderRadius:10,padding:"14px 16px",
                color:C.text,fontSize:18,outline:"none",
                fontFamily:"DM Mono,monospace",boxSizing:"border-box",
                letterSpacing:"0.05em"
              }}
            />
            <div style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",
              fontSize:22,pointerEvents:"none"}}>📷</div>
          </div>
          <div style={{fontSize:13,color:C.text3,marginBottom:20}}>
            Press <kbd style={{background:C.border,padding:"2px 8px",borderRadius:4,fontFamily:"monospace"}}>Enter</kbd> after scanning or typing
          </div>
          <div style={{display:"flex",gap:10}}>
            <Btn variant="ghost" onClick={()=>{setScanModalOpen(false);setScanInput("");}} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn onClick={()=>{if(scanInput.trim()){const v=scanInput.trim();setScanModalOpen(false);setScanInput("");setTimeout(()=>handleInvScan(v),50);}}} disabled={!scanInput.trim()} style={{flex:2,justifyContent:"center",background:`linear-gradient(135deg,${C.green},#16a34a)`,color:"#000",fontWeight:700}}>
              🔍 Look Up Product
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── SCAN RECEIVE MODAL ── */}
      {scanReceiveModal&&(()=>{
        const {product, isNew, barcode} = scanReceiveModal;
        return isNew ? (
          // Unknown barcode — show Add Product form pre-filled
          <Modal title="➕ New Product — Add to Inventory" onClose={()=>setScanReceiveModal(null)} wide>
            <div style={{background:"rgba(34,197,94,0.06)",border:`1px solid ${C.green}44`,
              borderRadius:10,padding:"10px 14px",marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:20}}>🔲</span>
              <div>
                <div style={{fontWeight:700,fontSize:14,color:C.green}}>New barcode scanned</div>
                <div style={{fontSize:13,color:C.text3,fontFamily:"DM Mono,monospace"}}>{barcode}</div>
              </div>
            </div>
            <ProductForm
              initial={{barcode, sku:"", name:"", price:"", stock:"", cat:"Electronics", emoji:"📦", image:""}}
              onSave={async(form)=>{
                await handleAdd(form);
                setScanReceiveModal(null);
                setScanToast({type:"ok",msg:`✅ Product added to inventory`});
                setTimeout(()=>setScanToast(null),3000);
              }}
              onClose={()=>setScanReceiveModal(null)}
              loading={saving}
              error={formError}
              isEdit={false}
            />
          </Modal>
        ) : (
          // Known product — quick stock receive
          <ReceiveStockModal
            product={product}
            onClose={()=>setScanReceiveModal(null)}
            onSave={async(qty)=>{
              const newStock = product.stock + qty;
              try{
                const r = await apiFetch(`/api/products/${product.id}`,{
                  method:"PATCH",
                  body:JSON.stringify({stock:newStock, branchId:activeBranch?.id||null}),
                });
                if(r.ok){
                  await fetchProducts(undefined,{skipCache:true});
                  setScanReceiveModal(null);
                  setScanToast({type:"ok",msg:`✅ +${qty} units added to ${product.name} (now ${newStock})`});
                  setTimeout(()=>setScanToast(null),3500);
                }
              }catch{
                setScanToast({type:"err",msg:"Failed to update stock."});
                setTimeout(()=>setScanToast(null),3000);
              }
            }}
          />
        );
      })()}

      {/* ADD modal */}
      {addModal&&<Modal title="Add New Product" onClose={()=>setAddModal(false)} wide>
        <ProductForm onSave={handleAdd} onClose={()=>setAddModal(false)} loading={saving} error={formError} isEdit={false}/>
      </Modal>}

      {/* EDIT modal */}
      {editModal&&<Modal title={`Edit: ${editModal.name}`} onClose={()=>setEditModal(null)} wide>
        <ProductForm initial={editModal} onSave={handleEdit} onClose={()=>setEditModal(null)} loading={saving} error={formError} isEdit={true}/>
      </Modal>}

      {/* DELETE confirm */}
      {deleteConfirm&&<Modal title="Delete Product" onClose={()=>setDeleteConfirm(null)}>
        <div style={{textAlign:"center",padding:"10px 0 20px"}}>
          <div style={{fontSize:48,marginBottom:12}}>{deleteConfirm.image?<img src={deleteConfirm.image} alt="" style={{width:64,height:64,borderRadius:12,objectFit:"cover"}}/>:deleteConfirm.emoji||"📦"}</div>
          <div style={{fontWeight:700,fontSize:18,marginBottom:8}}>{deleteConfirm.name}</div>
          <div style={{color:C.text2,fontSize:15,lineHeight:1.6}}>This will deactivate the product and remove it from inventory.<br/>This action cannot be undone.</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn variant="ghost" onClick={()=>setDeleteConfirm(null)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
          <Btn variant="danger" onClick={()=>handleDelete(deleteConfirm.id)} style={{flex:1,justifyContent:"center"}}>🗑️ Delete Product</Btn>
        </div>
      </Modal>}

      {/* BARCODE modal */}
      {barcodeModal&&<BarcodeModal product={barcodeModal} onClose={()=>setBarcodeModal(null)} fetchProducts={fetchProducts}/>}

      {/* Manager: see own pending requests */}
      {perms.badge==="MANAGER"&&pendingTransfers.length>0&&(
        <div style={{marginTop:16,background:"rgba(99,102,241,0.06)",border:`1px solid ${C.blue}33`,borderRadius:12,padding:"12px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontWeight:700,fontSize:16,color:C.blue}}>🕐 Your Pending Transfer Requests ({pendingTransfers.length})</div>
            <button onClick={fetchPendingTransfers} title="Check for updates"
              style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:15,padding:"2px 6px",borderRadius:6,transition:"all 0.15s"}}
              onMouseEnter={e=>e.currentTarget.style.color=C.blue}
              onMouseLeave={e=>e.currentTarget.style.color=C.text3}>🔄</button>
          </div>
          {pendingTransfers.map(t=>(
            <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:`1px solid ${C.border}`,fontSize:14}}>
              <span>{t.product.emoji||"📦"}</span>
              <span style={{flex:1}}>{t.product.name} ×{t.quantity}</span>
              <span style={{color:C.text3}}>{branchLabel(t.fromBranch)} → {branchLabel(t.toBranch)}</span>
              <span style={{padding:"2px 8px",borderRadius:20,background:"rgba(245,158,11,0.12)",color:C.amber,fontSize:14,fontWeight:700}} title="Waiting for Admin to approve">⏳ AWAITING ADMIN</span>
            </div>
          ))}
        </div>
      )}

      {/* TRANSFER toast */}
      {transferToast&&<div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,
        padding:"11px 20px",borderRadius:10,fontSize:15,fontWeight:600,
        background:transferToast.startsWith("⚠️")?`${C.red}18`:`${C.green}18`,
        border:`1px solid ${transferToast.startsWith("⚠️")?C.red:C.green}44`,
        color:transferToast.startsWith("⚠️")?C.red:C.green,
        boxShadow:"0 8px 32px rgba(0,0,0,0.5)",animation:"fadeIn 0.2s ease"}}>
        {transferToast}
      </div>}

      {/* STOCK TRANSFER modal */}
      {transferModal&&<StockTransferModal
        product={transferModal}
        branches={branches}
        currentBranch={activeBranch}
        onClose={()=>setTransferModal(null)}
        onDone={(msg,status)=>{
          setTransferModal(null);
          setTransferToast(msg);
          setTimeout(()=>setTransferToast(null),4500);
          if(status==="approved") fetchProducts();
          fetchPendingTransfers();
        }}
      />}

      {/* BRANCH STOCK EDITOR modal */}
      {branchStockModal&&<BranchStockEditor
        product={branchStockModal}
        branches={branches}
        onClose={()=>{setBranchStockModal(null);fetchProducts();}}
      />}
    </div>
  );
}

/* ══════════ CUSTOMERS VIEW ══════════ */
function CustomersView({perms}){
  const [customers,setCustomers]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [search,setSearch]=useState("");
  const [tierFilter,setTierFilter]=useState("All");
  const [profileModal,setProfileModal]=useState(null);
  const [profileData,setProfileData]=useState(null);
  const [profileLoading,setProfileLoading]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [addModal,setAddModal]=useState(false);
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const [formError,setFormError]=useState("");
  const [toast,setToast]=useState(null);
  const [form,setForm]=useState({name:"",email:"",phone:"",notes:"",birthday:"",tags:""});
  const [pointsModal,setPointsModal]=useState(null);
  const [pointsDelta,setPointsDelta]=useState("");
  const [pointsReason,setPointsReason]=useState("");

  const showToast=(type,msg)=>{setToast({type,msg});setTimeout(()=>setToast(null),3500);};

  const getTier=(spent)=>{
    const s=parseFloat(spent||0);
    if(s>=100000) return{label:"VIP",   color:"#f59e0b",icon:"👑"};
    if(s>=20000)  return{label:"Gold",  color:"#eab308",icon:"🥇"};
    if(s>=5000)   return{label:"Silver",color:"#94a3b8",icon:"🥈"};
    return               {label:"Regular",color:C.text3, icon:"👤"};
  };

  const fetchCustomers=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const r=await apiFetch("/api/customers");
      const data=await r.json();
      if(!r.ok) throw new Error(data.error||"Failed to load customers");
      setCustomers(data);
    }catch(e){setError(getOfflineError(e.message));}
    setLoading(false);
  },[]);

  useEffect(()=>{ if(perms.customers) fetchCustomers(); else setLoading(false); },[fetchCustomers,perms.customers]);

  // Auto-refresh customers every 60s (loyalty points update from other terminals)
  useEffect(()=>{
    if(!perms.customers) return;
    const t = setInterval(()=>{ if(navigator.onLine) fetchCustomers(); }, 60000);
    return ()=>clearInterval(t);
  },[fetchCustomers, perms.customers]);

  const openProfile=async(c)=>{
    setProfileModal(c);setProfileData(null);setProfileLoading(true);
    try{
      const r=await apiFetch(`/api/customers/${c.id}`);
      const d=await r.json();
      if(r.ok) setProfileData(d);
    }catch{}
    setProfileLoading(false);
  };

  const saveCustomer=async()=>{
    if(!form.name.trim()){setFormError("Name is required.");return;}
    setSaving(true);setFormError("");
    try{
      const isEdit=!!editModal;
      const url=isEdit?`/api/customers/${editModal.id}`:"/api/customers";
      const method=isEdit?"PATCH":"POST";
      // Sanitize: send null instead of "" so unique constraint never fires on blank email
      const payload={
        ...form,
        email:   form.email?.trim()   || undefined,
        phone:   form.phone?.trim()   || undefined,
        notes:   form.notes?.trim()   || undefined,
        tags:    form.tags?.trim()    || undefined,
        birthday:form.birthday?.trim()|| undefined,
      };
      const r=await apiFetch(url,{method,body:JSON.stringify(payload)});
      const data=await r.json();
      if(!r.ok){setFormError(data.error||"Failed.");setSaving(false);return;}
      await fetchCustomers();
      setAddModal(false);setEditModal(null);
      setForm({name:"",email:"",phone:"",notes:"",birthday:"",tags:""});
      showToast("ok",isEdit?"Customer updated.":"Customer added.");
    }catch{setFormError("Cannot connect to server.");}
    setSaving(false);
  };

  const deleteCustomer=async(id)=>{
    try{
      const r=await apiFetch(`/api/customers/${id}`,{method:"DELETE"});
      if(r.ok){setCustomers(cs=>cs.filter(c=>c.id!==id));setDeleteConfirm(null);setProfileModal(null);showToast("ok","Customer deleted.");}
    }catch{showToast("err","Failed to delete.");}
  };

  const adjustPoints=async()=>{
    if(!pointsDelta||!pointsModal) return;
    const r=await apiFetch(`/api/customers/${pointsModal.id}/points`,{
      method:"POST",body:JSON.stringify({delta:parseInt(pointsDelta),reason:pointsReason||"Manual adjustment"}),
    });
    const d=await r.json();
    if(r.ok){
      // Update the single customer in local state immediately — no full re-fetch needed
      setCustomers(prev=>prev.map(c=>c.id===d.id?{...c,points:d.points}:c));
      // Also update profile modal if open
      if(profileData?.id===d.id) setProfileData(p=>({...p,points:d.points}));
      setPointsModal(prev=>prev?{...prev,points:d.points}:null);
      setPointsModal(null);setPointsDelta("");setPointsReason("");
      showToast("ok",`${parseInt(pointsDelta)>0?"+"+parseInt(pointsDelta)+" pts added":Math.abs(parseInt(pointsDelta))+" pts redeemed"} · New balance: ${d.points.toLocaleString()} pts`);
    }
  };

  if(!perms.customers) return <LockedBanner reason="Customer management is available to Managers and Admins only."/>;

  const TIERS=["All","VIP","Gold","Silver","Regular"];
  const filtered=customers.filter(c=>{
    const matchSearch=c.name.toLowerCase().includes(search.toLowerCase())||
      (c.email||"").toLowerCase().includes(search.toLowerCase())||
      (c.phone||"").includes(search)||(c.tags||"").toLowerCase().includes(search.toLowerCase());
    const matchTier=tierFilter==="All"||getTier(c.totalSpent).label===tierFilter;
    return matchSearch&&matchTier;
  });

  const totalSpent=customers.reduce((s,c)=>s+parseFloat(c.totalSpent||0),0);
  const totalPoints=customers.reduce((s,c)=>s+(c.points||0),0);
  const avgSpent=customers.length>0?totalSpent/customers.length:0;

  const openAdd=()=>{setForm({name:"",email:"",phone:"",notes:"",birthday:"",tags:""});setFormError("");setAddModal(true);};
  const openEdit=(c)=>{
    setForm({name:c.name,email:c.email||"",phone:c.phone||"",notes:c.notes||"",
      birthday:c.birthday?c.birthday.split("T")[0]:"",tags:c.tags||""});
    setFormError("");setEditModal(c);
  };

  return(
    <div style={{padding:"12px 10px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>
      {toast&&<div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,padding:"11px 20px",borderRadius:10,fontSize:15,fontWeight:600,background:toast.type==="ok"?`${C.green}18`:`${C.red}18`,border:`1px solid ${toast.type==="ok"?C.green:C.red}44`,color:toast.type==="ok"?C.green:C.red,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>{toast.type==="ok"?"✅":"⚠️"} {toast.msg}</div>}

      {/* KPI row */}
      <div className="r-grid-stats r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
        {[{label:"Total Customers",val:customers.length,icon:"👥",color:C.blue},{label:"Total Revenue",val:ksh(totalSpent),icon:"💰",color:C.amber},{label:"Avg Spend",val:ksh(avgSpent),icon:"📊",color:C.purple},{label:"Loyalty Points",val:totalPoints.toLocaleString(),icon:"⭐",color:C.green}].map(s=>(
          <Card key={s.label} style={{padding:16,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:38,height:38,borderRadius:10,background:s.color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>{s.icon}</div>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:500,color:s.color}}>{s.val}</div>
              <div style={{fontSize:14,color:C.text3,marginTop:1}}>{s.label}</div>
            </div>
          </Card>
        ))}
      </div>

      {/* Search + tier filters + add */}
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{flex:1,minWidth:200,position:"relative"}}>
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:C.text3}}>🔍</span>
          <Input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name, phone, email, tags…" style={{paddingLeft:36}}/>
        </div>
        <div style={{display:"flex",gap:4}}>
          {TIERS.map(t=>(
            <button key={t} onClick={()=>setTierFilter(t)}
              style={{padding:"7px 12px",borderRadius:8,border:`1px solid ${tierFilter===t?C.amber:C.border}`,background:tierFilter===t?C.amberGlow:"transparent",color:tierFilter===t?C.amber:C.text2,cursor:"pointer",fontSize:15,fontWeight:600}}>
              {t}
            </button>
          ))}
        </div>
        {perms.customersAdd&&<Btn onClick={openAdd}>+ Add Customer</Btn>}
      </div>

      {loading&&<div style={{textAlign:"center",padding:60}}><span style={{width:32,height:32,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/></div>}
      {error&&<div style={{background:error.startsWith("📶")?C.amber+"15":C.red+"15",border:`1px solid ${error.startsWith("📶")?C.amber:C.red}44`,borderRadius:8,padding:14,fontSize:15,color:error.startsWith("📶")?C.amber:C.red}}>{error}</div>}

      {/* Customer cards */}
      {!loading&&!error&&(
        filtered.length===0
          ?<div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 20px",gap:16}}>
            <div style={{width:88,height:88,borderRadius:24,background:"rgba(167,139,250,0.06)",border:`1px dashed ${C.purple}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={C.purple} strokeWidth={1.2} opacity={0.5}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:700,color:C.text2,marginBottom:6}}>
                {search||tierFilter!=="All"?"No customers found":"No customers yet"}
              </div>
              <div style={{fontSize:15,color:C.text3,maxWidth:220,lineHeight:1.5}}>
                {search||tierFilter!=="All"?"Try adjusting your search or filter.":"Add your first customer to start tracking purchases and loyalty points."}
              </div>
            </div>
            {!search&&tierFilter==="All"&&perms.customersAdd&&<Btn onClick={openAdd} style={{marginTop:4}}>+ Add First Customer</Btn>}
          </div>
          :<div className="r-grid-auto" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {filtered.map(c=>{
              const tier=getTier(c.totalSpent);
              const tagList=(c.tags||"").split(",").map(t=>t.trim()).filter(Boolean);
              return(
                <Card key={c.id} onClick={()=>openProfile(c)} style={{padding:16,cursor:"pointer"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <div style={{width:42,height:42,borderRadius:12,background:`linear-gradient(135deg,${tier.color}33,${tier.color}11)`,border:`2px solid ${tier.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:18,color:tier.color,flexShrink:0}}>
                        {c.name[0].toUpperCase()}
                      </div>
                      <div>
                        <div style={{fontWeight:700,fontSize:16}}>{c.name}</div>
                        <div style={{fontSize:14,color:tier.color,fontWeight:600,marginTop:1}}>{tier.icon} {tier.label}</div>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                      {perms.customersAdd&&<button onClick={()=>openEdit(c)} style={{width:26,height:26,borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",color:C.text3,cursor:"pointer",fontSize:13}}>✏️</button>}
                      {perms.customersDelete&&<button onClick={()=>setDeleteConfirm(c)} style={{width:26,height:26,borderRadius:6,border:`1px solid ${C.red}44`,background:"transparent",color:C.red,cursor:"pointer",fontSize:13}}>✕</button>}
                    </div>
                  </div>
                  <div style={{fontSize:15,color:C.text3,marginBottom:6}}>
                    {c.phone&&<div>📞 {c.phone}</div>}
                    {c.email&&<div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>✉️ {c.email}</div>}
                  </div>
                  {tagList.length>0&&(
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                      {tagList.map(tag=><span key={tag} style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:"rgba(99,102,241,0.1)",color:C.blue,border:`1px solid ${C.blue}22`,fontWeight:600}}>{tag}</span>)}
                    </div>
                  )}
                  <div className="r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                    {[{label:"Orders",val:c.totalOrders||0,color:C.blue},{label:"Spent",val:ksh(parseFloat(c.totalSpent||0)),color:C.amber},{label:"Points",val:(c.points||0).toLocaleString(),color:C.green}].map(s=>(
                      <div key={s.label} style={{background:C.sidebar,borderRadius:8,padding:"6px",textAlign:"center"}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:s.color}}>{s.val}</div>
                        <div style={{fontSize:14,color:C.text3,marginTop:1}}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
      )}

      {/* Profile modal */}
      {profileModal&&(
        <Modal title={profileModal.name} onClose={()=>{setProfileModal(null);setProfileData(null);}}>
          {profileLoading&&<div style={{textAlign:"center",padding:32}}><span style={{width:28,height:28,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/></div>}
          {!profileLoading&&profileData&&(()=>{
            const tier=getTier(profileData.totalSpent);
            return(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",gap:14,alignItems:"center",padding:"12px 16px",borderRadius:12,background:`linear-gradient(135deg,${tier.color}10,${tier.color}04)`,border:`1px solid ${tier.color}33`}}>
                  <div style={{width:56,height:56,borderRadius:16,background:`linear-gradient(135deg,${tier.color}33,${tier.color}15)`,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:24,color:tier.color,flexShrink:0}}>{profileData.name[0].toUpperCase()}</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:18}}>{profileData.name}</div>
                    <div style={{fontSize:14,color:tier.color,fontWeight:600,marginTop:2}}>{tier.icon} {tier.label}</div>
                    <div style={{fontSize:15,color:C.text3,marginTop:2}}>
                      {profileData.phone&&<span style={{marginRight:10}}>📞 {profileData.phone}</span>}
                      {profileData.email&&<span>✉️ {profileData.email}</span>}
                    </div>
                  </div>
                  <button onClick={()=>{setProfileModal(null);openEdit(profileData);}} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text2,cursor:"pointer",fontSize:15,fontWeight:600}}>✏️ Edit</button>
                </div>
                <div className="r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                  {[{label:"Orders",val:profileData.totalOrders||0,color:C.blue},{label:"Spent",val:ksh(parseFloat(profileData.totalSpent||0)),color:C.amber},{label:"Avg Order",val:ksh(profileData.avgOrder||0),color:C.purple},{label:"Points",val:(profileData.points||0).toLocaleString(),color:C.green}].map(s=>(
                    <div key={s.label} style={{background:C.sidebar,borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:600,color:s.color}}>{s.val}</div>
                      <div style={{fontSize:15,color:C.text3,marginTop:3}}>{s.label}</div>
                    </div>
                  ))}
                </div>
                {(profileData.notes||profileData.tags)&&(
                  <div style={{padding:"10px 14px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`}}>
                    {profileData.notes&&<div style={{fontSize:14,color:C.text2,marginBottom:6}}>📝 {profileData.notes}</div>}
                    {profileData.tags&&<div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {profileData.tags.split(",").map(t=>t.trim()).filter(Boolean).map(tag=><span key={tag} style={{fontSize:10,padding:"2px 8px",borderRadius:20,background:"rgba(99,102,241,0.1)",color:C.blue,border:`1px solid ${C.blue}22`}}>{tag}</span>)}
                    </div>}
                  </div>
                )}
                <button onClick={()=>setPointsModal(profileData)} style={{padding:"9px",borderRadius:8,border:`1px solid ${C.green}44`,background:"rgba(34,197,94,0.06)",color:C.green,cursor:"pointer",fontSize:14,fontWeight:600}}>⭐ Manage Points ({(profileData.points||0).toLocaleString()} pts)</button>
                <div>
                  <div style={{fontWeight:700,fontSize:16,marginBottom:8}}>Purchase History ({profileData.orders.length})</div>
                  {profileData.orders.length===0
                    ?<div style={{textAlign:"center",color:C.text3,fontSize:14,padding:16}}>No purchases yet</div>
                    :<div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:280,overflowY:"auto"}}>
                      {profileData.orders.map(o=>(
                        <div key={o.id} style={{padding:"10px 12px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <div>
                              <div style={{fontWeight:600,fontSize:14}}>{o.orderNumber}</div>
                              <div style={{fontSize:14,color:C.text3}}>{new Date(o.createdAt).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"})} · {o.paymentMethod}</div>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:500,color:o.status==="refunded"?C.red:C.green}}>KSh {parseFloat(o.total).toLocaleString()}</div>
                              <div style={{fontSize:14,fontWeight:600,color:C.text3,textTransform:"uppercase"}}>{o.status}</div>
                            </div>
                          </div>
                          <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:4}}>
                            {o.orderItems.map(item=><span key={item.id} style={{fontSize:14,color:C.text3}}>{item.product.emoji||"📦"} {item.product.name} ×{item.quantity}</span>)}
                          </div>
                        </div>
                      ))}
                    </div>
                  }
                </div>
                {perms.customersDelete&&<button onClick={()=>setDeleteConfirm(profileData)} style={{padding:"8px",borderRadius:8,border:`1px solid ${C.red}44`,background:"rgba(239,68,68,0.06)",color:C.red,cursor:"pointer",fontSize:14,fontWeight:600}}>🗑 Delete Customer</button>}
              </div>
            );
          })()}
        </Modal>
      )}

      {/* Add/Edit modal */}
      {(addModal||editModal)&&(
        <Modal title={editModal?"Edit Customer":"Add New Customer"} onClose={()=>{setAddModal(false);setEditModal(null);}}>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[["Full Name *","name","text"],["Phone (+254…)","phone","tel"],["Email","email","email"],["Birthday","birthday","date"]].map(([lbl,key,type])=>(
              <div key={key}>
                <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>{lbl}</label>
                <Input type={type} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} placeholder={lbl.replace(" *","")}/>
              </div>
            ))}
            <div>
              <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Tags (comma-separated)</label>
              <Input value={form.tags} onChange={e=>setForm(f=>({...f,tags:e.target.value}))} placeholder="vip, wholesale, regular…"/>
            </div>
            <div>
              <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Staff Notes</label>
              <textarea value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Any notes about this customer…" rows={2} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card,color:C.text,fontSize:14,resize:"vertical",outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
            </div>
            {formError&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 12px",fontSize:14,color:C.red}}>⚠️ {formError}</div>}
            <Btn onClick={saveCustomer} disabled={saving} style={{width:"100%",justifyContent:"center",marginTop:4}}>
              {saving?"Saving…":editModal?"💾 Save Changes":"+ Add Customer"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* Points modal */}
      {pointsModal&&(
        <Modal title={`Points — ${pointsModal.name}`} onClose={()=>setPointsModal(null)}>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{textAlign:"center",padding:"10px 0"}}>
              <div style={{fontSize:36,fontWeight:800,color:C.green,fontFamily:"'DM Mono',monospace"}}>{(pointsModal.points||0).toLocaleString()}</div>
              <div style={{fontSize:14,color:C.text3}}>Current Points</div>
            </div>
            <div className="r-kpi-4" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[50,100,200,500].map(v=><button key={v} onClick={()=>setPointsDelta(String(v))} style={{padding:"8px",borderRadius:8,border:`1px solid ${pointsDelta===String(v)?C.green:C.border}`,background:pointsDelta===String(v)?"rgba(34,197,94,0.1)":"transparent",color:pointsDelta===String(v)?C.green:C.text2,cursor:"pointer",fontSize:14,fontWeight:600}}>+{v} pts</button>)}
            </div>
            <div>
              <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Custom (− to redeem)</label>
              <Input type="number" value={pointsDelta} onChange={e=>setPointsDelta(e.target.value)} placeholder="+50 to add, -50 to redeem"/>
            </div>
            <div>
              <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Reason</label>
              <Input value={pointsReason} onChange={e=>setPointsReason(e.target.value)} placeholder="Birthday bonus, redeemed for discount…"/>
            </div>
            <Btn onClick={adjustPoints} disabled={!pointsDelta} style={{width:"100%",justifyContent:"center"}}>
              {parseInt(pointsDelta||0)>=0?"⭐ Add Points":"🎫 Redeem Points"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteConfirm&&(
        <Modal title="Delete Customer" onClose={()=>setDeleteConfirm(null)}>
          <div style={{textAlign:"center",padding:"10px 0"}}>
            <div style={{fontSize:40,marginBottom:12}}>⚠️</div>
            <div style={{fontSize:16,marginBottom:6}}>Delete <strong>{deleteConfirm.name}</strong>?</div>
            <div style={{fontSize:14,color:C.text3,marginBottom:20}}>This cannot be undone. Order history is preserved.</div>
            <div style={{display:"flex",gap:10}}>
              <Btn variant="ghost" onClick={()=>setDeleteConfirm(null)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
              <Btn variant="danger" onClick={()=>deleteCustomer(deleteConfirm.id)} style={{flex:1,justifyContent:"center"}}>Delete</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RefundsView({perms,branches,activeBranch,fetchProducts}){
  const [tab,setTab]=useState("process");         // "process" | "history"
  const [search,setSearch]=useState("");
  const [searchResults,setSearchResults]=useState([]);
  const [searching,setSearching]=useState(false);
  const [selectedOrder,setSelectedOrder]=useState(null);
  const [returnItems,setReturnItems]=useState({});     // { orderItemId: qty }
  const [restoreStock,setRestoreStock]=useState({});   // { orderItemId: bool }
  const [reason,setReason]=useState("");
  const [refundMethod,setRefundMethod]=useState("cash");
  const [notes,setNotes]=useState("");
  const [processing,setProcessing]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState(null);      // the completed refund
  const [history,setHistory]=useState([]);
  const [histLoading,setHistLoading]=useState(false);
  const [receiptModal,setReceiptModal]=useState(null);

  const NON_RESELLABLE_REASONS=["Defective / damaged product","Product expired"];

  const REASONS=[
    "Defective / damaged product",
    "Wrong item received",
    "Customer changed mind",
    "Product expired",
    "Overcharged",
    "Duplicate transaction",
    "Other",
  ];

  // ── Order search ──────────────────────────────────────────────────────────
  const doSearch=useCallback(async(q)=>{
    if(!q.trim()){setSearchResults([]);return;}
    setSearching(true);
    try{
      const r=await apiFetch(`/api/refunds/orders/search?q=${encodeURIComponent(q)}`);
      const data=await r.json();
      if(r.ok) setSearchResults(Array.isArray(data)?data:[]);
      else setSearchResults([]);
    }catch{setSearchResults([]);}
    setSearching(false);
  },[]);

  useEffect(()=>{
    const t=setTimeout(()=>doSearch(search),400);
    return()=>clearTimeout(t);
  },[search,doSearch]);

  // ── Select an order ───────────────────────────────────────────────────────
  const selectOrder=(order)=>{
    setSelectedOrder(order);
    setSearchResults([]);
    setSearch("");
    setError("");
    setSuccess(null);
    // Default: pre-select all returnable items at qty 0
    const init={};
    const initRestore={};
    order.orderItems.forEach(item=>{
      init[item.id]=0;
      initRestore[item.id]=true; // default: restore stock (assume resellable)
    });
    setReturnItems(init);
    setRestoreStock(initRestore);
  };

  // ── Calculate refund amount ───────────────────────────────────────────────
  const calcRefundAmt=()=>{
    if(!selectedOrder) return 0;
    return selectedOrder.orderItems.reduce((sum,item)=>{
      const qty=returnItems[item.id]||0;
      return sum+qty*parseFloat(item.unitPrice);
    },0);
  };

  // ── Already refunded per item ─────────────────────────────────────────────
  const getMaxQty=(item)=>{
    if(!selectedOrder) return item.quantity;
    // Check refunds on this order for this item
    const refundedQty=(selectedOrder.refunds||[])
      .filter(r=>r.status==="approved")
      .reduce((s,r)=>s+(r.items||[])
        .filter(ri=>ri.orderItemId===item.id)
        .reduce((ss,ri)=>ss+ri.quantity,0),0);
    return item.quantity-refundedQty;
  };

  // ── Submit refund ─────────────────────────────────────────────────────────
  const submitRefund=async()=>{
    setError("");
    const items=Object.entries(returnItems)
      .filter(([,qty])=>qty>0)
      .map(([orderItemId,quantity])=>{
        const oi=selectedOrder.orderItems.find(x=>x.id===parseInt(orderItemId));
        return{
          orderItemId:parseInt(orderItemId),
          productId:oi.productId,
          quantity,
          unitPrice:parseFloat(oi.unitPrice),
          restoreStock: restoreStock[parseInt(orderItemId)] !== false, // default true
        };
      });
    if(!items.length){setError("Select at least one item to return.");return;}
    if(!reason){setError("Please select a reason.");return;}
    setProcessing(true);
    try{
      const r=await apiFetch("/api/refunds",{
        method:"POST",
        body:JSON.stringify({
          orderId:selectedOrder.id,
          items,reason,refundMethod,
          notes:notes||null,
        }),
      });
      const data=await r.json();
      if(!r.ok){setError(data.error||"Refund failed.");setProcessing(false);return;}
      setSuccess(data.refund);
      setSelectedOrder(null);
      setReturnItems({});
      setRestoreStock({});
      setReason("");
      setNotes("");
      fetchProducts();
      // Auto-print refund receipt
      setTimeout(()=>printRefundReceipt(data.refund), 300);
    }catch{setError(getOfflineError("Cannot connect to server."));}
    setProcessing(false);
  };

  // ── Load history ──────────────────────────────────────────────────────────
  const loadHistory=useCallback(async()=>{
    setHistLoading(true);
    try{
      const r=await apiFetch("/api/refunds?days=30");
      const data=await r.json();
      if(r.ok) setHistory(Array.isArray(data)?data:[]);
    }catch{}
    setHistLoading(false);
  },[]);

  useEffect(()=>{if(tab==="history") loadHistory();},[tab,loadHistory]);

  // ── Refund receipt print ──────────────────────────────────────────────────
  const printRefundReceipt=(refund)=>{
    if(!refund) return;
    const methodLabel=refund.refundMethod==="store_credit"?"Store Credit":refund.refundMethod==="mobile"?"M-Pesa":"Cash";
    const lines=[
      `<html><head><title>Refund Receipt</title>`,
      `<style>body{font-family:Arial,sans-serif;max-width:320px;margin:0 auto;padding:20px;color:#000}`,
      `.center{text-align:center}.mono{font-family:monospace}.bold{font-weight:bold}`,
      `.hr{border-top:1px dashed #999;margin:10px 0}.big{font-size:20px}.sm{font-size:11px}`,
      `</style></head><body>`,
      `<div class="center"><div style="font-size:22px;font-weight:900;letter-spacing:-1px">STARMART</div>`,
      `<div style="font-size:12px;color:#666;margin-bottom:4px">Point of Sale</div>`,
      `<div style="font-size:16px;font-weight:700;padding:6px 16px;background:#fee2e2;color:#dc2626;border-radius:6px;display:inline-block;margin:6px 0">↩ REFUND RECEIPT</div></div>`,
      `<div class="hr"></div>`,
      `<p class="sm"><b>Ref #:</b> ${refund.refundNumber||"—"}</p>`,
      `<p class="sm"><b>Original Order:</b> ${refund.order?.orderNumber||refund.orderId}</p>`,
      `<p class="sm"><b>Date:</b> ${new Date(refund.createdAt).toLocaleString("en-KE")}</p>`,
      `<p class="sm"><b>Processed by:</b> ${refund.processedBy?.name||"—"}</p>`,
      `<p class="sm"><b>Reason:</b> ${refund.reason}</p>`,
      `<div class="hr"></div>`,
      `<div class="bold sm" style="margin-bottom:6px">RETURNED ITEMS:</div>`,
      ...(refund.items||[]).map(item=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span>${item.product?.emoji||"📦"} ${item.product?.name||"Item"} × ${item.quantity}</span><span>KSh ${parseFloat(item.subtotal||0).toLocaleString()}</span></div>`),
      `<div class="hr"></div>`,
      `<div style="display:flex;justify-content:space-between;font-size:18px;font-weight:900;padding:6px 0">`,
      `<span>REFUND TOTAL</span><span style="color:#dc2626">KSh ${parseFloat(refund.amount).toLocaleString()}</span></div>`,
      `<p class="sm"><b>Refund Method:</b> ${methodLabel}</p>`,
      refund.notes?`<p class="sm"><i>📝 ${refund.notes}</i></p>`:"",
      `<div class="hr"></div>`,
      `<div class="center sm" style="color:#666">We apologise for any inconvenience.<br/>Thank you for shopping with us.</div>`,
      `<div class="center sm" style="margin-top:12px;color:#999">${new Date().toLocaleDateString("en-KE",{day:"numeric",month:"long",year:"numeric"})}</div>`,
      `</body></html>`,
    ].join("");
    const w=window.open("","_blank","width=420,height=700");
    w.document.write(lines);
    w.document.close();
    setTimeout(()=>w.print(),400);
  };

  const totalRefundAmt=calcRefundAmt();
  const hasSelections=Object.values(returnItems).some(q=>q>0);

  return(
    <div style={{padding:"12px 10px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div>
          <div style={{fontWeight:800,fontSize:18}}>Refunds & Returns</div>
          <div style={{fontSize:15,color:C.text3,marginTop:3}}>Process returns and issue refunds to customers</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {["process","history"].map(t=>(
            <button key={t} onClick={()=>setTab(t)}
              style={{padding:"7px 16px",borderRadius:8,border:`1px solid ${tab===t?C.blue:C.border}`,
                background:tab===t?C.blueGlow:"transparent",color:tab===t?C.blue:C.text2,
                cursor:"pointer",fontSize:14,fontWeight:600,textTransform:"capitalize"}}>
              {t==="process"?"↩ Process Return":"📋 History"}
            </button>
          ))}
        </div>
      </div>

      {/* ── SUCCESS BANNER ── */}
      {success&&(
        <div style={{background:"rgba(34,197,94,0.08)",border:`1px solid ${C.green}33`,
          borderRadius:12,padding:"16px 20px",marginBottom:16,
          display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontWeight:700,color:C.green,fontSize:16}}>✅ Refund processed successfully!</div>
            <div style={{fontSize:14,color:C.text2,marginTop:2}}>
              {success.refundNumber} — KSh {parseFloat(success.amount).toLocaleString()} via {success.refundMethod==="store_credit"?"Store Credit":success.refundMethod==="mobile"?"M-Pesa":"Cash"}
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>printRefundReceipt(success)}
              style={{padding:"7px 14px",borderRadius:8,border:`1px solid ${C.green}44`,
                background:C.greenGlow,color:C.green,cursor:"pointer",fontSize:14,fontWeight:600}}>
              🖨 Print Receipt
            </button>
            <button onClick={()=>setSuccess(null)}
              style={{padding:"7px 14px",borderRadius:8,border:`1px solid ${C.border}`,
                background:"transparent",color:C.text3,cursor:"pointer",fontSize:14}}>
              New Return
            </button>
          </div>
        </div>
      )}

      {tab==="process"&&(
        <div className="r-grid-auto r-form-2col" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>

          {/* LEFT: Order search */}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Card style={{padding:20}}>
              <div style={{fontWeight:700,fontSize:16,marginBottom:12}}>🔍 Find Order</div>
              <div style={{position:"relative"}}>
                <Input
                  placeholder="Order # · Customer name · Phone…"
                  value={search}
                  onChange={e=>{setSearch(e.target.value);setSelectedOrder(null);}}
                  style={{paddingLeft:36}}
                />
                <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:18}}>🔍</span>
              </div>
              {searching&&<div style={{textAlign:"center",padding:12,color:C.text3,fontSize:14}}>Searching…</div>}
              {searchResults.length>0&&(
                <div style={{marginTop:8,borderRadius:10,border:`1px solid ${C.border}`,overflow:"hidden",maxHeight:280,overflowY:"auto"}}>
                  {searchResults.map(order=>{
                    const alreadyRefunded=parseFloat(order.refunds?.reduce((s,r)=>s+(r.status==="approved"?parseFloat(r.amount):0),0)||0);
                    const isFullyRefunded=alreadyRefunded>=parseFloat(order.total)-0.01;
                    return(
                      <button key={order.id} onClick={()=>!isFullyRefunded&&selectOrder(order)}
                        style={{width:"100%",display:"flex",alignItems:"flex-start",gap:10,padding:"10px 14px",
                          background:isFullyRefunded?"rgba(239,68,68,0.04)":"rgba(255,255,255,0.02)",
                          border:"none",borderBottom:`1px solid ${C.border}`,cursor:isFullyRefunded?"default":"pointer",
                          textAlign:"left",opacity:isFullyRefunded?0.6:1}}>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:600,fontSize:15,color:C.text}}>{order.orderNumber}</div>
                          <div style={{fontSize:15,color:C.text3,marginTop:1}}>
                            {order.customer?.name||"Walk-in"} · {new Date(order.createdAt).toLocaleDateString("en-KE")}
                          </div>
                          <div style={{fontSize:15,color:C.text2,marginTop:1}}>
                            {order.orderItems.length} item{order.orderItems.length!==1?"s":""} · KSh {parseFloat(order.total).toLocaleString()}
                          </div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          {isFullyRefunded
                            ?<span style={{fontSize:14,fontWeight:700,color:C.red,background:"rgba(239,68,68,0.1)",padding:"2px 8px",borderRadius:20}}>REFUNDED</span>
                            :alreadyRefunded>0
                              ?<span style={{fontSize:14,fontWeight:700,color:C.amber,background:C.amberGlow,padding:"2px 8px",borderRadius:20}}>PARTIAL</span>
                              :<span style={{fontSize:14,fontWeight:700,color:C.green,background:"rgba(34,197,94,0.1)",padding:"2px 8px",borderRadius:20}}>ELIGIBLE</span>
                          }
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {search&&!searching&&searchResults.length===0&&(
                <div style={{textAlign:"center",padding:16,color:C.text3,fontSize:14}}>No completed orders found for "{search}"</div>
              )}
            </Card>

            {/* Selected order details */}
            {selectedOrder&&(
              <Card style={{padding:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:16}}>{selectedOrder.orderNumber}</div>
                    <div style={{fontSize:15,color:C.text3,marginTop:2}}>
                      {selectedOrder.customer?.name||"Walk-in"} · {new Date(selectedOrder.createdAt).toLocaleString("en-KE")}
                    </div>
                    <div style={{fontSize:15,color:C.text3}}>
                      {branchLabel(selectedOrder.branch)||"Main"} · Paid via {selectedOrder.paymentMethod}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:18,fontWeight:500}}>
                      KSh {parseFloat(selectedOrder.total).toLocaleString()}
                    </div>
                    <button onClick={()=>{setSelectedOrder(null);setReturnItems({});setRestoreStock({});}}
                      style={{fontSize:14,color:C.text3,background:"none",border:"none",cursor:"pointer",marginTop:2,textDecoration:"underline"}}>
                      Clear
                    </button>
                  </div>
                </div>

                {/* Items to return */}
                <div style={{fontSize:13,color:C.text3,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>
                  Select Items to Return
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {selectedOrder.orderItems.map(item=>{
                    const maxQty=getMaxQty(item);
                    const currentQty=returnItems[item.id]||0;
                    const alreadyReturned=item.quantity-maxQty;
                    return(
                      <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
                        borderRadius:10,background:currentQty>0?"rgba(99,102,241,0.06)":"rgba(255,255,255,0.02)",
                        border:`1px solid ${currentQty>0?C.blue:C.border}`,transition:"all 0.15s"}}>
                        <span style={{fontSize:20,flexShrink:0}}>{item.product?.emoji||"📦"}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:14,fontWeight:600}}>{item.product?.name||"Item"}</div>
                          <div style={{fontSize:14,color:C.text3}}>
                            KSh {parseFloat(item.unitPrice).toLocaleString()} × {item.quantity}
                            {alreadyReturned>0&&<span style={{color:C.amber,marginLeft:6}}>({alreadyReturned} already returned)</span>}
                          </div>
                        </div>
                        {maxQty>0?(
                          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5,flexShrink:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              <button onClick={()=>setReturnItems(p=>({...p,[item.id]:Math.max(0,(p[item.id]||0)-1)}))}
                                style={{width:26,height:26,borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",
                                  color:C.text,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                              <span style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:600,minWidth:20,textAlign:"center"}}>
                                {currentQty}
                              </span>
                              <button onClick={()=>setReturnItems(p=>({...p,[item.id]:Math.min(maxQty,(p[item.id]||0)+1)}))}
                                style={{width:26,height:26,borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",
                                  color:C.text,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                              <button onClick={()=>setReturnItems(p=>({...p,[item.id]:maxQty}))}
                                style={{fontSize:14,color:C.blue,background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>
                                All
                              </button>
                            </div>
                            {currentQty>0&&(
                              <button
                                onClick={()=>setRestoreStock(p=>({...p,[item.id]:!p[item.id]}))}
                                title={restoreStock[item.id]?"Stock will be added back — click to mark as not resellable":"Stock will NOT be added back — click to mark as resellable"}
                                style={{display:"flex",alignItems:"center",gap:4,padding:"2px 8px",
                                  borderRadius:20,border:`1px solid ${restoreStock[item.id]?C.green:C.red}44`,
                                  background:restoreStock[item.id]?"rgba(34,197,94,0.08)":"rgba(239,68,68,0.08)",
                                  color:restoreStock[item.id]?C.green:C.red,
                                  cursor:"pointer",fontSize:14,fontWeight:600}}>
                                {restoreStock[item.id]?"📦 Return to stock":"🗑 Write off"}
                              </button>
                            )}
                          </div>
                        ):(
                          <span style={{fontSize:14,fontWeight:700,color:C.red,background:"rgba(239,68,68,0.1)",padding:"2px 8px",borderRadius:20}}>RETURNED</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>

          {/* RIGHT: Refund details */}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Card style={{padding:20}}>
              <div style={{fontWeight:700,fontSize:16,marginBottom:16}}>↩ Refund Details</div>

              {/* Reason */}
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,color:C.text2,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>
                  Return Reason *
                </label>
                <Select value={reason} onChange={e=>{
                  const newReason=e.target.value;
                  setReason(newReason);
                  // Auto-set restoreStock defaults based on reason
                  if(selectedOrder){
                    const nonResellable=NON_RESELLABLE_REASONS.includes(newReason);
                    const newRestore={};
                    selectedOrder.orderItems.forEach(item=>{
                      // Only override if user hasn't manually toggled
                      newRestore[item.id]=!nonResellable;
                    });
                    setRestoreStock(newRestore);
                  }
                }} style={{width:"100%"}}>
                  <option value="">Select a reason…</option>
                  {REASONS.map(r=><option key={r} value={r}>{r}</option>)}
                </Select>
              </div>

              {/* Refund method */}
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,color:C.text2,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:8}}>
                  Refund Method *
                </label>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {[["cash","💵 Cash"],["mobile","📱 M-Pesa"],["store_credit","🎫 Store Credit"]].map(([val,label])=>(
                    <button key={val} onClick={()=>setRefundMethod(val)}
                      style={{padding:"10px 6px",borderRadius:9,border:`1px solid ${refundMethod===val?C.blue:C.border}`,
                        background:refundMethod===val?C.blueGlow:"transparent",
                        color:refundMethod===val?C.blue:C.text2,
                        cursor:"pointer",fontSize:15,fontWeight:600,textAlign:"center",transition:"all 0.15s"}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes */}
              <div style={{marginBottom:16}}>
                <label style={{fontSize:13,color:C.text2,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>
                  Notes (optional)
                </label>
                <textarea value={notes} onChange={e=>setNotes(e.target.value)}
                  placeholder="Any additional notes about this return…"
                  rows={2}
                  style={{width:"100%",padding:"10px 12px",borderRadius:8,border:`1px solid ${C.border}`,
                    background:C.card,color:C.text,fontSize:14,resize:"vertical",outline:"none",
                    fontFamily:"inherit",boxSizing:"border-box"}}
                />
              </div>

              {/* Refund total */}
              <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"14px 16px",marginBottom:16,
                border:`1px solid ${hasSelections?C.blue:C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:14,color:C.text2}}>Items selected</div>
                  <div style={{fontSize:14,fontWeight:600}}>
                    {Object.values(returnItems).reduce((s,q)=>s+q,0)} item(s)
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
                  <div style={{fontWeight:700,fontSize:16}}>Refund Amount</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:500,
                    color:totalRefundAmt>0?C.green:C.text3}}>
                    KSh {totalRefundAmt.toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2})}
                  </div>
                </div>
                {refundMethod==="cash"&&totalRefundAmt>0&&(
                  <div style={{fontSize:15,color:C.amber,marginTop:6,fontWeight:500}}>
                    💵 Hand KSh {totalRefundAmt.toLocaleString()} cash to customer
                  </div>
                )}
                {refundMethod==="mobile"&&totalRefundAmt>0&&(
                  <div style={{fontSize:15,color:C.green,marginTop:6,fontWeight:500}}>
                    📱 Send KSh {totalRefundAmt.toLocaleString()} via M-Pesa to customer
                  </div>
                )}
                {refundMethod==="store_credit"&&totalRefundAmt>0&&(
                  <div style={{fontSize:15,color:C.blue,marginTop:6,fontWeight:500}}>
                    🎫 KSh {totalRefundAmt.toLocaleString()} added as store credit
                  </div>
                )}
                {hasSelections&&(()=>{
                  const toRestore=Object.entries(returnItems)
                    .filter(([id,qty])=>qty>0&&restoreStock[parseInt(id)]!==false)
                    .reduce((s,[,qty])=>s+qty,0);
                  const toWriteOff=Object.entries(returnItems)
                    .filter(([id,qty])=>qty>0&&restoreStock[parseInt(id)]===false)
                    .reduce((s,[,qty])=>s+qty,0);
                  return(
                    <div style={{marginTop:8,fontSize:13,display:"flex",flexDirection:"column",gap:3}}>
                      {toRestore>0&&<span style={{color:C.green}}>📦 {toRestore} unit{toRestore!==1?"s":""} will be returned to stock</span>}
                      {toWriteOff>0&&<span style={{color:C.red}}>🗑 {toWriteOff} unit{toWriteOff!==1?"s":""} will be written off (not resellable)</span>}
                    </div>
                  );
                })()}
              </div>

              {error&&(
                <div style={{background:error.startsWith("📶")?C.amberGlow:C.redGlow,border:`1px solid ${error.startsWith("📶")?C.amber:C.red}44`,borderRadius:8,
                  padding:"10px 14px",marginBottom:12,fontSize:14,color:error.startsWith("📶")?C.amber:C.red}}>
                  {error}
                </div>
              )}

              <Btn
                onClick={submitRefund}
                disabled={!selectedOrder||!hasSelections||!reason||processing}
                style={{width:"100%",justifyContent:"center",padding:"12px",fontSize:16,fontWeight:700,
                  opacity:(!selectedOrder||!hasSelections||!reason||processing)?0.5:1}}>
                {processing
                  ?<><span style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite",marginRight:8}}/>Processing…</>
                  :"↩ Process Refund"}
              </Btn>

              {!selectedOrder&&(
                <div style={{textAlign:"center",marginTop:12,fontSize:15,color:C.text3}}>
                  Search for an order on the left to begin
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab==="history"&&(
        <Card style={{padding:20}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:16}}>Refund History (Last 30 days)</div>
            <button onClick={loadHistory}
              style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:15}}>🔄</button>
          </div>
          {histLoading&&(
            <div style={{textAlign:"center",padding:32}}>
              <span style={{width:28,height:28,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/>
            </div>
          )}
          {!histLoading&&history.length===0&&(
            <div style={{textAlign:"center",padding:32,color:C.text3,fontSize:15}}>No refunds in the last 30 days</div>
          )}
          {!histLoading&&history.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {history.map(refund=>(
                <div key={refund.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:10,background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`}}>
                  <div style={{width:38,height:38,borderRadius:10,background:"rgba(239,68,68,0.1)",
                    display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>↩</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:15}}>{refund.refundNumber}</div>
                    <div style={{fontSize:15,color:C.text3}}>
                      Order {refund.order?.orderNumber||refund.orderId} · {refund.reason}
                    </div>
                    <div style={{fontSize:14,color:C.text3,marginTop:1}}>
                      {new Date(refund.createdAt).toLocaleString("en-KE")} · by {refund.processedBy?.name||"—"}
                      {refund.branch&&<span> · {branchLabel(refund.branch)}</span>}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:17,fontWeight:500,color:C.red}}>
                      −KSh {parseFloat(refund.amount).toLocaleString()}
                    </div>
                    <div style={{fontSize:14,color:C.text3,marginTop:1,textTransform:"capitalize"}}>
                      {refund.refundMethod==="store_credit"?"Store Credit":refund.refundMethod}
                    </div>
                  </div>
                  <button onClick={()=>printRefundReceipt(refund)}
                    title="Print receipt"
                    style={{width:32,height:32,borderRadius:8,border:`1px solid ${C.border}`,
                      background:"transparent",color:C.text3,cursor:"pointer",fontSize:16,
                      display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    🖨
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// SECURITY VIEW — Audit Logs, Fraud Detection, Access Control, Backup
// ─────────────────────────────────────────────────────────────────────────────
function SecurityView(){
  const [tab,setTab]=useState("overview");
  const [summary,setSummary]=useState(null);
  const [auditLogs,setAuditLogs]=useState([]);
  const [fraudAlerts,setFraudAlerts]=useState(null);
  const [loading,setLoading]=useState(false);
  const [toast,setToast]=useState(null);
  const [auditSearch,setAuditSearch]=useState("");
  const [auditActionFilter,setAuditActionFilter]=useState("");
  const [auditDaysFilter,setAuditDaysFilter]=useState(90);
  const [auditPage,setAuditPage]=useState(1);
  const [auditTotal,setAuditTotal]=useState(0);

  const showToast=(type,msg)=>{setToast({type,msg});setTimeout(()=>setToast(null),4000);};

  // ── Fetch summary on mount ──────────────────────────────────────────────
  useEffect(()=>{
    apiFetch("/api/security/summary")
      .then(r=>r.ok?r.json():null)
      .then(d=>{ if(d) setSummary(d); })
      .catch(()=>{});
  },[]);

  // ── Fetch data by tab ───────────────────────────────────────────────────
  useEffect(()=>{
    if(tab==="fraud") fetchFraudAlerts();
    if(tab!=="audit") return;
    // Debounce text search by 400ms so we don't fire on every keystroke
    const timer = setTimeout(()=>fetchAuditLogs(), auditSearch ? 400 : 0);
    return ()=>clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tab, auditPage, auditActionFilter, auditSearch, auditDaysFilter]);

  // Auto-refresh active tab every 45s
  useEffect(()=>{
    const t = setInterval(()=>{
      if(!navigator.onLine) return;
      if(tab==="overview"||tab==="audit") fetchAuditLogs();
      if(tab==="fraud") fetchFraudAlerts();
    }, 45000);
    return ()=>clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tab]);


  const fetchAuditLogs=async()=>{
    setLoading(true);
    try{
      const params=new URLSearchParams({page:auditPage,limit:50,days:auditDaysFilter||90});
      if(auditSearch) params.set("search",auditSearch);
      if(auditActionFilter) params.set("action",auditActionFilter);
      const r=await apiFetch(`/api/security/audit-logs?${params}`);
      const d=await r.json();
      if(r.ok){ setAuditLogs(d.logs||[]); setAuditTotal(d.total||0); }
    }catch{}
    setLoading(false);
  };

  const fetchFraudAlerts=async()=>{
    setLoading(true);
    try{
      const r=await apiFetch("/api/security/fraud-alerts?days=7");
      const d=await r.json();
      if(r.ok) setFraudAlerts(d);
    }catch{}
    setLoading(false);
  };

  const downloadBackup=async()=>{
    showToast("ok","Preparing backup…");
    try{
      const r=await apiFetch("/api/security/backup");
      const blob=await r.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=`starmart_backup_${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast("ok","✅ Backup downloaded successfully.");
    }catch{ showToast("err","Backup failed."); }
  };

  const [dismissingId,setDismissingId]=useState(null);
  // Persist dismissed keys in localStorage so they survive page refresh
  const [dismissedKeys,setDismissedKeys]=useState(()=>{
    try{ return new Set(JSON.parse(localStorage.getItem("starmart_dismissed_alerts")||"[]")); }
    catch{ return new Set(); }
  });
  const addDismissedKey=(key)=>{
    setDismissedKeys(prev=>{
      const next=new Set([...prev,key]);
      try{ localStorage.setItem("starmart_dismissed_alerts",JSON.stringify([...next])); }catch{}
      return next;
    });
  };

  const dismissAlert=async(alertType,recordId)=>{
    const key=`${alertType}_${recordId}`;
    setDismissingId(key);
    try{
      const r=await apiFetch("/api/security/fraud-alerts/dismiss",{
        method:"POST",
        body:JSON.stringify({alertType,recordId,reason:"Reviewed by admin"}),
      });
      if(r.ok){
        // Add to local dismissed set — don't refetch, alert would just reappear
        const key=`${alertType}_${recordId}`;
        addDismissedKey(key);
        showToast("ok","Alert dismissed and logged.");
      } else {
        const d=await r.json().catch(()=>({}));
        showToast("err",d.error||"Failed to dismiss alert.");
      }
    }catch{
      showToast("err","Cannot connect to server.");
    }
    setDismissingId(null);
  };

  const TABS=[
    {id:"overview",label:"🛡 Overview"},
    {id:"audit",   label:"📋 Audit Log"},
    {id:"fraud",   label:"🚨 Fraud Alerts"},
    {id:"access",  label:"🔐 Access Control"},
    {id:"backup",  label:"💾 Backup"},
  ];

  const ACTION_COLORS={
    ORDER_CREATED:"rgba(34,197,94,0.1)",
    LOGIN:"rgba(99,102,241,0.1)",
    LOGIN_FAILED:"rgba(239,68,68,0.1)",
    FRAUD_ALERT_LARGE_ORDER:"rgba(245,158,11,0.1)",
    FRAUD_ALERT_RAPID_ORDERS:"rgba(245,158,11,0.1)",
    DATA_BACKUP:"rgba(99,102,241,0.1)",
    FRAUD_ALERT_DISMISSED:"rgba(34,197,94,0.1)",
  };
  const ACTION_ICONS={
    ORDER_CREATED:"🛒",LOGIN:"🔑",LOGIN_FAILED:"⚠️",
    FRAUD_ALERT_LARGE_ORDER:"🚨",FRAUD_ALERT_RAPID_ORDERS:"🚨",
    DATA_BACKUP:"💾",FRAUD_ALERT_DISMISSED:"✅",
  };

  const visibleAlerts=(arr,key)=>
    (arr||[]).filter(item=>!dismissedKeys.has(`${key}_${item.id||item.userId}`));
  const totalFraudAlerts=fraudAlerts
    ?(visibleAlerts(fraudAlerts.largeOrders,"largeOrders").length
     +visibleAlerts(fraudAlerts.voidedOrders,"voidedOrders").length
     +visibleAlerts(fraudAlerts.rapidUsers,"rapidUsers").length
     +visibleAlerts(fraudAlerts.highRefundUsers,"highRefundUsers").length)
    :0;

  return(
    <div style={{padding:"12px 10px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>
      {toast&&(
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,
          padding:"11px 20px",borderRadius:10,fontSize:15,fontWeight:600,
          background:toast.type==="ok"?`${C.green}18`:`${C.red}18`,
          border:`1px solid ${toast.type==="ok"?C.green:C.red}44`,
          color:toast.type==="ok"?C.green:C.red,
          boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
          {toast.type==="ok"?"✅":"⚠️"} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div>
          <div style={{fontWeight:800,fontSize:18}}>Security Centre</div>
          <div style={{fontSize:15,color:C.text3,marginTop:3}}>Audit logs · Fraud detection · Access control · Backup</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:18,overflowX:"auto",paddingBottom:2}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{padding:"7px 16px",borderRadius:8,border:`1px solid ${tab===t.id?C.blue:C.border}`,
              background:tab===t.id?C.blueGlow:"transparent",
              color:tab===t.id?C.blue:C.text2,
              cursor:"pointer",fontSize:14,fontWeight:600,whiteSpace:"nowrap",
              position:"relative"}}>
            {t.label}
            {t.id==="fraud"&&totalFraudAlerts>0&&(
              <span style={{position:"absolute",top:-6,right:-6,background:C.red,color:"#fff",
                fontSize:14,fontWeight:800,width:16,height:16,borderRadius:8,
                display:"flex",alignItems:"center",justifyContent:"center"}}>
                {totalFraudAlerts}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {/* KPI cards */}
          <div className="r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
            {[
              {label:"Audit Events (30d)",val:summary?.totalAuditLogs??"-",icon:"📋",color:C.blue},
              {label:"Logins (7d)",       val:summary?.logins7d??"-",     icon:"🔑",color:C.green},
              {label:"Failed Logins (7d)",val:summary?.failedLogins7d??"-",icon:"⚠️",color:C.red},
              {label:"Active Staff",      val:summary?.activeUsers??"-",   icon:"👤",color:C.amber},
            ].map(s=>(
              <Card key={s.label} style={{padding:16}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:36,borderRadius:10,background:s.color+"20",
                    display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:500,color:s.color}}>{s.val}</div>
                    <div style={{fontSize:14,color:C.text3,marginTop:1}}>{s.label}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Security status checklist */}
          <Card style={{padding:20}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:14}}>🔒 Security Status</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                {ok:true,  label:"Encrypted Payments",       detail:"All M-Pesa transactions use Safaricom's TLS-encrypted Daraja API. No card data stored."},
                {ok:true,  label:"Password Hashing",         detail:"All passwords hashed with bcrypt (cost 12). Plaintext passwords never stored."},
                {ok:true,  label:"JWT Authentication",        detail:"Stateless tokens with 7-day expiry. Role and branch embedded in token."},
                {ok:true,  label:"Role-Based Access Control", detail:"Cashier / Manager / Admin roles enforced on every API route via requireRole() middleware."},
                {ok:true,  label:"Transaction Audit Logs",    detail:"Every order, login, and refund is written to the audit_logs table with timestamp and IP."},
                {ok:true,  label:"Fraud Detection",          detail:"Large orders (>50K), rapid transactions, late-night sales, and high refund ratios are flagged."},
                {ok:true,  label:"Rate Limiting",            detail:"Auth routes: 20 req/15min. Global: 500 req/15min. Prevents brute-force attacks."},
                {ok:true,  label:"CORS Protection",          detail:"Only your frontend origin can call the API. Cross-site requests from other domains are blocked."},
                {ok:true,  label:"Branch Isolation",         detail:"Staff are locked to their assigned branch. Cross-branch data requires admin access."},
                {ok:true,  label:"Data Backup",              detail:"Full JSON export available on demand. Schedule regular downloads for disaster recovery."},
              ].map(item=>(
                <div key={item.label} style={{display:"flex",gap:12,padding:"10px 14px",
                  borderRadius:10,background:item.ok?"rgba(34,197,94,0.04)":"rgba(239,68,68,0.04)",
                  border:`1px solid ${item.ok?C.green:C.red}22`}}>
                  <span style={{fontSize:18,flexShrink:0,marginTop:1}}>{item.ok?"✅":"❌"}</span>
                  <div>
                    <div style={{fontWeight:600,fontSize:15,color:item.ok?C.green:C.red}}>{item.label}</div>
                    <div style={{fontSize:15,color:C.text3,marginTop:2}}>{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── AUDIT LOG ── */}

      {tab==="audit"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          {/* Search + filter bar */}
          <Card style={{padding:"14px 16px"}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              <div style={{flex:"1 1 200px",position:"relative"}}>
                <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:C.text3}}>🔍</span>
                <input
                  value={auditSearch}
                  onChange={e=>{setAuditSearch(e.target.value);setAuditPage(1);}}
                  placeholder="Search by name, action, e.g. Joseph, sale, login…"
                  style={{width:"100%",paddingLeft:32,paddingRight:12,paddingTop:8,paddingBottom:8,
                    borderRadius:8,border:`1px solid ${C.border}`,background:C.card,color:C.text,
                    fontSize:14,outline:"none",boxSizing:"border-box"}}
                />
              </div>
              <select value={auditActionFilter||""} onChange={e=>{setAuditActionFilter(e.target.value);setAuditPage(1);}}
                style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card,color:C.text,fontSize:14,cursor:"pointer"}}>
                <option value="">All Actions</option>
                <option value="LOGIN">🔐 Logins</option>
                <option value="ORDER_CREATED">💳 Sales</option>
                <option value="REFUND_PROCESSED">🔁 Refunds</option>
                <option value="PRODUCT">📦 Products</option>
                <option value="CUSTOMER">👤 Customers</option>
                <option value="STAFF">👥 Staff</option>
                <option value="BRANCH">🏪 Branches</option>
                <option value="STOCK_TRANSFER">📤 Transfers</option>
                <option value="FRAUD_ALERT">⚠️ Fraud</option>
              </select>
              <select value={auditDaysFilter||90} onChange={e=>{setAuditDaysFilter(+e.target.value);setAuditPage(1);}}
                style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card,color:C.text,fontSize:14,cursor:"pointer"}}>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
                <option value={365}>Last year</option>
              </select>
              <button onClick={fetchAuditLogs}
                style={{padding:"8px 14px",borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text2,cursor:"pointer",fontSize:14,fontWeight:600}}>
                🔄 Refresh
              </button>
            </div>
          </Card>

          {/* Log list */}
          <Card style={{padding:0,overflow:"hidden"}}>
            {/* Header */}
            <div style={{padding:"12px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:15}}>📋 Activity Log</div>
              <div style={{fontSize:13,color:C.text3}}>
                {auditTotal.toLocaleString()} events · page {auditPage} of {Math.ceil(auditTotal/50)||1}
              </div>
            </div>

            {loading&&(
              <div style={{textAlign:"center",padding:40}}>
                <span style={{width:28,height:28,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/>
                <div style={{marginTop:12,color:C.text3,fontSize:14}}>Loading activity…</div>
              </div>
            )}

            {!loading&&auditLogs.length===0&&(
              <div style={{textAlign:"center",padding:40,color:C.text3}}>
                <div style={{fontSize:32,marginBottom:10}}>📭</div>
                <div style={{fontSize:15,fontWeight:600}}>No activity found</div>
                <div style={{fontSize:13,marginTop:4}}>Try adjusting your search or date range</div>
              </div>
            )}

            {!loading&&auditLogs.length>0&&(
              <div style={{maxHeight:560,overflowY:"auto"}}>
                {auditLogs.map((log,i)=>{
                  const role  = log.user?.role||"system";
                  const name  = log.user?.name||"System";
                  const email = log.user?.email||"";
                  const initials = name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
                  const roleColor = role==="admin"?"#6366F1":role==="manager"?"#F59E0B":"#22C55E";
                  const isOrder   = log.action==="ORDER_CREATED";
                  const isLogin   = log.action.includes("LOGIN");
                  const isRefund  = log.action.includes("REFUND");
                  const isFraud   = log.action.includes("FRAUD");
                  const rowBg     = isFraud?"rgba(239,68,68,0.05)":isOrder?"rgba(34,197,94,0.04)":"transparent";
                  const borderL   = isFraud?`3px solid ${C.red}`:isOrder?`3px solid ${C.green}`:isRefund?`3px solid ${C.amber}`:`3px solid transparent`;
                  return(
                    <div key={log.id} style={{display:"flex",gap:12,padding:"12px 20px",
                      borderBottom:`1px solid ${C.border}`,background:rowBg,borderLeft:borderL,
                      transition:"background 0.1s"}}
                      onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.03)"}
                      onMouseLeave={e=>e.currentTarget.style.background=rowBg}>

                      {/* Avatar */}
                      <div style={{flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                        <div style={{width:36,height:36,borderRadius:10,background:roleColor+"22",
                          border:`1.5px solid ${roleColor}44`,display:"flex",alignItems:"center",
                          justifyContent:"center",fontWeight:700,fontSize:14,color:roleColor}}>
                          {initials||"SY"}
                        </div>
                        {i<auditLogs.length-1&&<div style={{width:1,flex:1,minHeight:8,background:C.border}}/>}
                      </div>

                      {/* Content */}
                      <div style={{flex:1,minWidth:0}}>
                        {/* Name + role + time */}
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontWeight:700,fontSize:14,color:C.text}}>{name}</span>
                          <span style={{fontSize:11,fontWeight:700,color:roleColor,background:roleColor+"18",
                            padding:"1px 7px",borderRadius:20,textTransform:"uppercase",letterSpacing:"0.05em"}}>
                            {role}
                          </span>
                          {email&&<span style={{fontSize:12,color:C.text3}}>{email}</span>}
                          <span style={{marginLeft:"auto",fontSize:12,color:C.text3,flexShrink:0,whiteSpace:"nowrap"}}>
                            {new Date(log.createdAt).toLocaleString("en-KE",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}
                          </span>
                        </div>

                        {/* Human description */}
                        <div style={{fontSize:14,color:C.text,lineHeight:1.5,marginBottom:log.ipAddress?3:0}}>
                          {log.description||log.action}
                        </div>

                        {/* IP + table/record meta */}
                        <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:2}}>
                          {log.ipAddress&&(
                            <span style={{fontSize:12,color:C.text3}}>📍 {log.ipAddress}</span>
                          )}
                          {log.tableName&&log.tableName!=="—"&&(
                            <span style={{fontSize:12,color:C.text3}}>
                              {log.tableName}{log.recordId?` #${log.recordId}`:""}
                            </span>
                          )}
                          <span style={{fontSize:12,color:C.text3,fontFamily:"'DM Mono',monospace",
                            background:"rgba(255,255,255,0.04)",padding:"1px 6px",borderRadius:5}}>
                            {log.action}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination */}
            {auditTotal>50&&(
              <div style={{padding:"10px 20px",borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <button onClick={()=>setAuditPage(p=>Math.max(1,p-1))} disabled={auditPage<=1}
                  style={{padding:"6px 14px",borderRadius:7,border:`1px solid ${C.border}`,background:"transparent",
                    color:auditPage<=1?C.text3:C.text,cursor:auditPage<=1?"not-allowed":"pointer",fontSize:14,fontWeight:600}}>
                  ← Prev
                </button>
                <span style={{fontSize:13,color:C.text3}}>Page {auditPage} of {Math.ceil(auditTotal/50)}</span>
                <button onClick={()=>setAuditPage(p=>p+1)} disabled={auditPage>=Math.ceil(auditTotal/50)}
                  style={{padding:"6px 14px",borderRadius:7,border:`1px solid ${C.border}`,background:"transparent",
                    color:auditPage>=Math.ceil(auditTotal/50)?C.text3:C.text,
                    cursor:auditPage>=Math.ceil(auditTotal/50)?"not-allowed":"pointer",fontSize:14,fontWeight:600}}>
                  Next →
                </button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── FRAUD ALERTS ── */}
      {tab==="fraud"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:14,color:C.text3}}>Last 7 days · flags transactions that match known fraud patterns</div>
            <button onClick={fetchFraudAlerts}
              style={{background:"none",border:"none",color:C.text3,cursor:"pointer",fontSize:15}}>🔄 Refresh</button>
          </div>
          {loading&&<div style={{textAlign:"center",padding:32}}><span style={{width:28,height:28,border:`3px solid ${C.border}`,borderTopColor:C.red,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/></div>}
          {fraudAlerts&&!loading&&[
            {key:"largeOrders",   title:"🚨 Large Orders (> KSh 50,000)",     desc:"Single transactions significantly above average"},
            {key:"voidedOrders",  title:"⚠️ Voided Orders",                    desc:"Orders cancelled after being processed"},

            {key:"rapidUsers",    title:"⚡ High-Volume Users (≥10 orders)",   desc:"Staff with unusually high order counts"},
            {key:"highRefundUsers",title:"↩ High Refund Ratio (>30%)",         desc:"Staff with more refunds than expected"},
          ].map(section=>{
            const items=fraudAlerts[section.key]||[];
            return(
              <Card key={section.key} style={{padding:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:16}}>{section.title}</div>
                    <div style={{fontSize:15,color:C.text3,marginTop:2}}>{section.desc}</div>
                  </div>
                  {(()=>{
                    const remaining=items.filter(item=>!dismissedKeys.has(`${section.key}_${item.id||item.userId}`)).length;
                    return(
                      <span style={{padding:"2px 10px",borderRadius:20,fontSize:13,fontWeight:700,
                        background:remaining>0?"rgba(239,68,68,0.1)":"rgba(34,197,94,0.1)",
                        color:remaining>0?C.red:C.green,border:`1px solid ${remaining>0?C.red:C.green}33`}}>
                        {remaining} alert{remaining!==1?"s":""}
                      </span>
                    );
                  })()}
                </div>
                {(()=>{ const rem=items.filter(item=>!dismissedKeys.has(`${section.key}_${item.id||item.userId}`)).length; return rem===0; })()
                  ?<div style={{fontSize:14,color:C.green,textAlign:"center",padding:"8px 0",fontWeight:600}}>✅ All alerts dismissed</div>
                  :<div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {items.filter(item=>!dismissedKeys.has(`${section.key}_${item.id||item.userId}`)).slice(0,5).map((item,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",
                        borderRadius:8,background:"rgba(239,68,68,0.04)",border:`1px solid ${C.red}22`}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:14,fontWeight:600}}>
                            {item.orderNumber||item.userName||`Item ${i+1}`}
                          </div>
                          <div style={{fontSize:14,color:C.text3}}>
                            {item.total&&`KSh ${Number(item.total).toLocaleString()}`}
                            {item.orderCount&&` · ${item.orderCount} orders`}
                            {item.refundCount&&` · ${item.refundCount} refunds`}
                            {item.createdAt&&` · ${new Date(item.createdAt).toLocaleString("en-KE")}`}
                            {item.branchName&&` · ${item.branchName}`}
                            {item.userName&&item.orderNumber&&` · by ${item.userName}`}
                          </div>
                        </div>
                        <button
                          onClick={()=>dismissAlert(section.key, item.id||item.userId)}
                          disabled={dismissingId===`${section.key}_${item.id||item.userId}`}
                          style={{padding:"4px 10px",borderRadius:7,border:`1px solid ${C.border}`,
                            background:"transparent",color:C.text3,cursor:"pointer",fontSize:14,fontWeight:600,
                            flexShrink:0,opacity:dismissingId===`${section.key}_${item.id||item.userId}`?0.5:1}}>
                          {dismissingId===`${section.key}_${item.id||item.userId}`?"…":"Dismiss"}
                        </button>
                      </div>
                    ))}
                    {items.length>5&&<div style={{fontSize:15,color:C.text3,textAlign:"center"}}>+{items.length-5} more</div>}
                  </div>
                }
              </Card>
            );
          })}
        </div>
      )}

      {/* ── ACCESS CONTROL ── */}
      {tab==="access"&&(
        <Card style={{padding:20}}>
          <div style={{fontWeight:700,fontSize:16,marginBottom:16}}>🔐 Role-Based Access Control</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {[
              {role:"Admin",   color:C.amber, icon:"⚙️",  perms:["Full system access","Create/delete staff","All branches","Process refunds","View audit logs","Download backups","All reports"]},
              {role:"Manager", color:C.blue,  icon:"📊",  perms:["Process sales","Edit inventory","Manage customers","View analytics","Process refunds","Request stock transfers","View own branch"]},
              {role:"Cashier", color:C.green, icon:"🏪",  perms:["Process sales only","View inventory (read-only)","Apply coupons","Basic receipt printing"]},
            ].map(r=>(
              <div key={r.role} style={{padding:"14px 16px",borderRadius:10,
                background:r.color+"08",border:`1px solid ${r.color}33`}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <span style={{fontSize:20}}>{r.icon}</span>
                  <div style={{fontWeight:700,fontSize:17,color:r.color}}>{r.role}</div>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {r.perms.map(p=>(
                    <span key={p} style={{fontSize:13,padding:"3px 10px",borderRadius:20,
                      background:r.color+"15",color:r.color,border:`1px solid ${r.color}33`,fontWeight:500}}>
                      ✓ {p}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:16,padding:"12px 16px",borderRadius:10,
            background:"rgba(99,102,241,0.06)",border:`1px solid ${C.blue}33`}}>
            <div style={{fontWeight:600,fontSize:15,color:C.blue,marginBottom:6}}>🔑 Authentication</div>
            <div style={{fontSize:14,color:C.text2,lineHeight:1.7}}>
              Passwords hashed with <strong>bcrypt (cost 12)</strong> · JWT tokens expire every <strong>7 days</strong> · Optional <strong>2FA via Email</strong> · Auth rate-limited to <strong>20 attempts / 15 min</strong> per IP · All login attempts (success & failure) logged
            </div>
          </div>
        </Card>
      )}

      {/* ── BACKUP ── */}
      {tab==="backup"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Card style={{padding:24}}>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
              <div style={{width:48,height:48,borderRadius:12,background:"rgba(99,102,241,0.12)",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>💾</div>
              <div>
                <div style={{fontWeight:700,fontSize:17}}>Full Data Backup</div>
                <div style={{fontSize:15,color:C.text3,marginTop:3}}>
                  Exports products, orders, customers, staff, branches, refunds and audit logs as JSON
                </div>
              </div>
            </div>
            <Btn onClick={downloadBackup} style={{padding:"12px 24px",fontSize:16,fontWeight:700}}>
              📥 Download Backup Now
            </Btn>
          </Card>

          <Card style={{padding:20}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:14}}>📋 Backup Best Practices</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[
                {icon:"🕐",title:"Daily backups",         detail:"Download a backup every morning before the business day starts."},
                {icon:"☁️",title:"Offsite storage",       detail:"Save backups to Google Drive, Dropbox, or email them to a secure address."},
                {icon:"🔒",title:"Encrypted storage",     detail:"Store backup files in password-protected folders or encrypted cloud storage."},
                {icon:"🔄",title:"Test recovery",         detail:"Periodically verify your backup files can be used to restore data."},
                {icon:"📅",title:"Retention policy",      detail:"Keep at least 30 days of daily backups and monthly backups for 1 year."},
                {icon:"🛡",title:"Audit log included",    detail:"Backup includes last 1,000 audit events for forensic recovery if needed."},
              ].map(item=>(
                <div key={item.title} style={{display:"flex",gap:12,padding:"10px 14px",
                  borderRadius:10,background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`}}>
                  <span style={{fontSize:18,flexShrink:0}}>{item.icon}</span>
                  <div>
                    <div style={{fontWeight:600,fontSize:14}}>{item.title}</div>
                    <div style={{fontSize:15,color:C.text3,marginTop:2}}>{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}


function ReportsView({perms}){
  const [summary,setSummary]=useState(null);
  const [daily,setDaily]=useState([]);
  const [topProducts,setTopProducts]=useState([]);
  const [catSales,setCatSales]=useState([]);
  const [monthly,setMonthly]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  const chartKsh=(v)=>`KSh ${Number(v).toLocaleString("en-KE")}`;
  useEffect(()=>{
    if(!perms.reports) return;
    setLoading(true);setError("");
    Promise.all([
      apiFetch('/api/reports/summary').then(r=>r.json()),
      apiFetch('/api/reports/daily?days=7').then(r=>r.json()),
      apiFetch('/api/reports/top-products?limit=5').then(r=>r.json()),
      apiFetch('/api/reports/category-sales').then(r=>r.json()),
      apiFetch('/api/reports/monthly?months=6').then(r=>r.ok?r.json():[]).catch(()=>[]),
    ]).then(([s,d,tp,cs,mo])=>{
      setSummary(s);
      setDaily(d.map(row=>({
        day: new Date(row.date).toLocaleDateString("en-KE",{weekday:"short"}),
        sales: parseFloat(row.revenue)||0,
        txns: row.transactions||0,
      })));
      setTopProducts(tp);
      setCatSales(cs.map((c,i)=>({name:c.category,value:parseFloat(c.revenue)||0,color:CAT_COLORS[i%CAT_COLORS.length]})));
      if(Array.isArray(mo)) setMonthly(mo.map(row=>({
        month: new Date(row.year,row.month-1).toLocaleDateString("en-KE",{month:"short",year:"2-digit"}),
        sales: parseFloat(row.revenue)||0,
        txns:  parseInt(row.transactions)||0,
      })));
    }).catch(e=>{
      console.error(e);
      setError(getOfflineError("Failed to load reports. Is the backend running?"));
    }).finally(()=>setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  if(!perms.reports) return <LockedBanner reason="Reports and analytics are restricted to Managers and Admins."/>;

  const handleExport=()=>{
    const url=`${API_URL}/api/reports/export`;
    const a=document.createElement("a");
    a.href=url;
    a.setAttribute("download","starmart_export.csv");
    // pass token via query (simplest approach without a form)
    apiFetch("/api/reports/export").then(r=>r.blob()).then(blob=>{
      const burl=URL.createObjectURL(blob);
      a.href=burl;document.body.appendChild(a);a.click();
      document.body.removeChild(a);URL.revokeObjectURL(burl);
    });
  };

  if(loading) return(
    <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14}}>
      <span style={{width:36,height:36,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:C.text3,fontSize:13}}>Loading analytics…</div>
    </div>
  );

  if(error) return(
    <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,padding:40,textAlign:"center"}}>
      <div style={{fontSize:40}}>⚠️</div>
      <div style={{color:C.red,fontSize:16}}>{error}</div>
    </div>
  );

  const todayRev   = parseFloat(summary?.today?.revenue||0);
  const todayTxns  = summary?.today?.transactions||0;
  const weekRev    = parseFloat(summary?.week?.revenue||0);
  const weekTxns   = summary?.week?.transactions||0;
  const avgOrder   = parseFloat(summary?.avgOrderValue||0);

  return(
    <div style={{padding:"14px 12px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,gap:8,flexWrap:"wrap"}}>
        <div style={{fontWeight:800,fontSize:20}}>Sales Analytics — Nairobi 🇰🇪</div>
        {perms.reportsExport
          ?<Btn variant="ghost" style={{fontSize:14,padding:"7px 14px"}} onClick={handleExport}>📥 Export CSV</Btn>
          :<div style={{fontSize:15,color:C.text3,padding:"7px 14px",background:C.card,border:`1px solid ${C.border}`,borderRadius:8}}>🔒 Export — Admin only</div>
        }
      </div>

      {/* KPI Cards — 2x2 on mobile, 4x1 on desktop */}
      <div className="r-grid-stats r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
        {[
          {label:"Today's Revenue",val:ksh(todayRev),sub:`${todayTxns} transaction${todayTxns!==1?"s":""}`,icon:"M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",color:C.green,trend:"+12%"},
          {label:"Transactions Today",val:todayTxns,sub:"Completed orders",icon:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",color:C.blue,trend:null},
          {label:"Avg Order Value",val:ksh(avgOrder),sub:"This week",icon:"M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z",color:C.purple,trend:null},
          {label:"Weekly Revenue",val:ksh(weekRev),sub:`${weekTxns} orders`,icon:"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",color:C.amber,trend:null},
        ].map(k=>(
          <div key={k.label} style={{background:C.card,border:`1px solid ${k.color}25`,borderRadius:12,padding:"14px 14px 12px",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:2.5,background:`linear-gradient(90deg,${k.color}99,${k.color}22)`}}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{width:32,height:32,borderRadius:8,background:k.color+"18",border:`1px solid ${k.color}33`,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <NavIcon path={k.icon} size={14} color={k.color}/>
              </div>
              {k.trend&&<span style={{fontSize:11,fontWeight:700,color:C.green,background:C.greenGlow,padding:"2px 7px",borderRadius:20}}>{k.trend}</span>}
            </div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:24,fontWeight:700,color:k.color,letterSpacing:"-0.02em",marginBottom:3,lineHeight:1.1}}>{k.val}</div>
            <div style={{fontSize:14,fontWeight:600,color:C.text,letterSpacing:"-0.01em",marginBottom:1}}>{k.label}</div>
            <div style={{fontSize:13,color:C.text3}}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Charts row — stack vertically on mobile */}
      <div style={{display:"grid",gridTemplateColumns:"1fr",gap:12,marginBottom:12}}>
        <Card>
          <div style={{fontWeight:600,fontSize:18,letterSpacing:"-0.02em",marginBottom:4}}>Revenue (7 days)</div><div style={{fontSize:15,color:C.text3,marginBottom:16}}>Daily sales in KES</div>
          {daily.length===0
            ?<div style={{height:190,display:"flex",alignItems:"center",justifyContent:"center",color:C.text3,fontSize:15}}>No sales data yet</div>
            :<ResponsiveContainer width="100%" height={180}>
              <AreaChart data={daily}>
                <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={0.2}/><stop offset="95%" stopColor={C.blue} stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                <XAxis dataKey="day" tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}K`} width={36}/>
                <Tooltip contentStyle={{background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:10,color:C.text,fontSize:14,boxShadow:'0 8px 24px rgba(0,0,0,0.4)'}} formatter={(v)=>[chartKsh(v),"Sales"]}/>
                <Area type="monotone" dataKey="sales" stroke={C.blue} strokeWidth={2.5} fill="url(#g1)" dot={false} activeDot={{r:4,fill:C.blue}}/>
              </AreaChart>
            </ResponsiveContainer>
          }
        </Card>
        <Card>
          <div style={{fontWeight:600,fontSize:18,letterSpacing:"-0.01em",marginBottom:8}}>Sales by Category</div>
          {catSales.length===0
            ?<div style={{height:190,display:"flex",alignItems:"center",justifyContent:"center",color:C.text3,fontSize:15}}>No data yet</div>
            :<>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={catSales} cx="50%" cy="50%" innerRadius={45} outerRadius={72} dataKey="value" paddingAngle={3}>
                    {catSales.map((_,i)=><Cell key={i} fill={CAT_COLORS[i%CAT_COLORS.length]}/>)}
                  </Pie>
                  <Tooltip
                    contentStyle={{background:"#0D1117",border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,boxShadow:'0 8px 32px rgba(0,0,0,0.7)',padding:"10px 14px"}}
                    formatter={(v,n,props)=>{
                      const col=props?.payload?.color||C.amber;
                      return[
                        <span style={{color:C.amber,fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:16}}>{chartKsh(v)}</span>,
                        <span style={{color:col,fontWeight:600}}>{n}</span>
                      ];
                    }}
                    labelStyle={{display:"none"}}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                {catSales.map((c,i)=>(
                  <div key={c.name} style={{display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                    <div style={{width:8,height:8,borderRadius:2,background:CAT_COLORS[i%CAT_COLORS.length]}}/>
                    <span style={{color:C.text2}}>{c.name}</span>
                  </div>
                ))}
              </div>
            </>
          }
        </Card>
      </div>

      {/* Monthly Revenue Chart */}
      {monthly.length>0&&(
        <Card style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
            <div>
              <div style={{fontWeight:600,fontSize:18,letterSpacing:"-0.01em"}}>Monthly Revenue</div>
              <div style={{fontSize:15,color:C.text3,marginTop:2}}>Last {monthly.length} months</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:18,fontWeight:500,color:C.amber}}>
                {ksh(monthly.reduce((s,m)=>s+m.sales,0))}
              </div>
              <div style={{fontSize:14,color:C.text3}}>{monthly.reduce((s,m)=>s+m.txns,0)} orders total</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthly} barSize={28}>
              <defs>
                <linearGradient id="monthGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.amber} stopOpacity={0.9}/>
                  <stop offset="100%" stopColor={C.amberDim} stopOpacity={0.6}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
              <XAxis dataKey="month" tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}K`}/>
              <Tooltip
                contentStyle={{background:"#0D1117",border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,boxShadow:'0 8px 32px rgba(0,0,0,0.7)',padding:"10px 14px"}}
                formatter={(v,n)=>[
                  <span style={{color:C.amber,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{ksh(v)}</span>,
                  <span style={{color:C.text2}}>Revenue</span>
                ]}
                labelStyle={{color:C.text,fontWeight:600,marginBottom:4}}
              />
              <Bar dataKey="sales" fill="url(#monthGrad)" radius={[6,6,0,0]}>
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* Month-over-month delta row */}
          <div style={{display:"flex",gap:6,marginTop:10,overflowX:"auto",paddingBottom:2}}>
            {monthly.map((m,i)=>{
              const prev=monthly[i-1];
              const delta=prev&&prev.sales>0?((m.sales-prev.sales)/prev.sales*100):null;
              return(
                <div key={m.month} style={{flex:"0 0 auto",textAlign:"center",minWidth:56,
                  padding:"6px 8px",borderRadius:8,
                  background:"rgba(255,255,255,0.03)",border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:14,color:C.text3,marginBottom:2}}>{m.month}</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:600,color:C.text}}>
                    {(m.sales/1000).toFixed(1)}K
                  </div>
                  {delta!==null&&(
                    <div style={{fontSize:14,fontWeight:700,color:delta>=0?C.green:C.red,marginTop:1}}>
                      {delta>=0?"▲":"▼"}{Math.abs(delta).toFixed(0)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Bottom row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr",gap:12}}>
        <Card>
          <div style={{fontWeight:600,fontSize:18,letterSpacing:"-0.01em",marginBottom:8}}>Daily Transactions</div>
          {daily.length===0
            ?<div style={{height:150,display:"flex",alignItems:"center",justifyContent:"center",color:C.text3,fontSize:15}}>No data yet</div>
            :<ResponsiveContainer width="100%" height={150}>
              <BarChart data={daily} barSize={22}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                <XAxis dataKey="day" tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:C.text3,fontSize:13}} axisLine={false} tickLine={false} allowDecimals={false}/>
                <Tooltip contentStyle={{background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:10,color:C.text,fontSize:14,boxShadow:'0 8px 24px rgba(0,0,0,0.4)'}}/>
                <Bar dataKey="txns" fill={C.blue} radius={[4,4,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          }
        </Card>
        <Card>
          <div style={{fontWeight:600,fontSize:18,letterSpacing:"-0.01em",marginBottom:8}}>Top Products by Revenue</div>
          {topProducts.length===0
            ?<div style={{padding:"30px 0",textAlign:"center",color:C.text3,fontSize:15}}>No sales recorded yet</div>
            :topProducts.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:i<topProducts.length-1?`1px solid ${C.border}`:"none"}}>
                <div style={{fontFamily:"DM Mono,monospace",fontSize:15,color:C.text3,width:14}}>{i+1}</div>
                <div style={{fontSize:18}}>{p.emoji||"📦"}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:500}}>{p.name}</div>
                  <div style={{fontSize:14,color:C.text3}}>{p.total_sold} sold</div>
                </div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:17,fontWeight:500,color:C.green,letterSpacing:"-0.02em"}}>{ksh(p.total_revenue)}</div>
              </div>
            ))
          }
        </Card>
      </div>

      {/* ── Cross-Branch Report ── */}
      <CrossBranchReport perms={perms}/>

      {/* ── Staff Performance ── */}
      <StaffPerformancePanel/>
    </div>
  );
}

/* ══════════ STAFF PERFORMANCE PANEL ══════════ */
function StaffPerformancePanel(){
  const [period, setPeriod]   = useState("weekly");
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const ROLE_COLOR = {admin:C.amber, manager:C.blue, cashier:C.green};
  const PERIOD_LABELS = {daily:"Today",weekly:"This Week",monthly:"This Month"};

  const load = (p = period) => {
    setLoading(true);
    apiFetch(`/api/reports/staff-performance?period=${p}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handlePeriod = (p) => { setPeriod(p); load(p); };

  const totalStaffRevenue = data?.staff?.reduce((s,x)=>s+Number(x.revenue),0)||1;
  const maxRevenue = data?.staff?.length ? Math.max(...data.staff.map(s=>Number(s.revenue))) : 1;

  return(
    <Card style={{padding:20,marginBottom:16}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{width:36,height:36,borderRadius:10,background:"rgba(99,102,241,0.12)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>👥</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:16,color:C.blue}}>Staff Performance</div>
          <div style={{fontSize:13,color:C.text3,marginTop:1}}>Sales by each staff member</div>
        </div>
        {/* Period selector */}
        <div style={{display:"flex",gap:4,background:C.card,borderRadius:8,padding:3,border:`1px solid ${C.border}`}}>
          {["daily","weekly","monthly"].map(p=>(
            <button key={p} onClick={()=>handlePeriod(p)}
              style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:"pointer",
                fontSize:13,fontWeight:600,transition:"all 0.15s",
                background:period===p?"rgba(99,102,241,0.2)":"transparent",
                color:period===p?C.blue:C.text3}}>
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <button onClick={()=>load(period)}
          style={{padding:"6px 10px",borderRadius:7,border:`1px solid ${C.border}`,
            background:"transparent",color:C.text3,cursor:"pointer",fontSize:14}}>
          🔄
        </button>
      </div>

      {loading&&(
        <div style={{textAlign:"center",padding:32}}>
          <span style={{width:24,height:24,border:`3px solid ${C.border}`,borderTopColor:C.blue,
            borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/>
          <div style={{color:C.text3,fontSize:14,marginTop:10}}>Loading staff data…</div>
        </div>
      )}

      {!loading&&data&&(
        <>
          {/* Summary row */}
          <div className="r-kpi-4" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
            {[
              {label:"Active Staff",val:data.totals.staff,icon:"👤",color:C.blue},
              {label:"Total Orders",val:data.totals.orders.toLocaleString(),icon:"🛒",color:C.green},
              {label:"Total Revenue",val:`KSh ${Number(data.totals.revenue).toLocaleString("en-KE",{maximumFractionDigits:0})}`,icon:"💰",color:C.amber},
            ].map(s=>(
              <div key={s.label} style={{padding:"10px 12px",borderRadius:10,
                background:s.color+"0D",border:`1px solid ${s.color}22`,textAlign:"center"}}>
                <div style={{fontSize:18,marginBottom:4}}>{s.icon}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:700,color:s.color}}>{s.val}</div>
                <div style={{fontSize:12,color:C.text3,marginTop:2}}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Staff list */}
          {data.staff.length===0&&(
            <div style={{textAlign:"center",padding:"30px 0",color:C.text3}}>
              <div style={{fontSize:32,marginBottom:8}}>📊</div>
              <div>No sales recorded {PERIOD_LABELS[period].toLowerCase()}</div>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {data.staff.map((s,i)=>{
              const isOpen = expanded === s.id;
              const barPct = totalStaffRevenue > 0 ? Math.max(4, Math.round((s.revenue / totalStaffRevenue) * 100)) : 4;
              const rc = ROLE_COLOR[s.role] || C.text3;
              const medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":"";
              return(
                <div key={s.id} style={{borderRadius:10,border:`1px solid ${isOpen?rc+"55":C.border}`,
                  overflow:"hidden",transition:"border-color 0.2s"}}>
                  {/* Staff row */}
                  <button onClick={()=>setExpanded(isOpen?null:s.id)}
                    style={{width:"100%",display:"flex",alignItems:"center",gap:12,
                      padding:"12px 14px",background:isOpen?rc+"0A":"transparent",
                      border:"none",cursor:"pointer",textAlign:"left",transition:"background 0.15s"}}
                    onMouseEnter={e=>!isOpen&&(e.currentTarget.style.background="rgba(255,255,255,0.02)")}
                    onMouseLeave={e=>!isOpen&&(e.currentTarget.style.background="transparent")}>

                    {/* Rank + Avatar */}
                    <div style={{position:"relative",flexShrink:0}}>
                      <div style={{width:38,height:38,borderRadius:10,background:rc+"22",
                        border:`1px solid ${rc}44`,display:"flex",alignItems:"center",
                        justifyContent:"center",fontWeight:700,fontSize:16,color:rc}}>
                        {s.name[0].toUpperCase()}
                      </div>
                      {medal&&<span style={{position:"absolute",top:-6,right:-6,fontSize:14}}>{medal}</span>}
                    </div>

                    {/* Name + role */}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontWeight:700,fontSize:16,color:C.text}}>{s.name}</span>
                        <span style={{fontSize:11,fontWeight:700,color:rc,background:rc+"18",
                          padding:"1px 7px",borderRadius:20,textTransform:"uppercase",letterSpacing:"0.04em"}}>
                          {s.role}
                        </span>
                      </div>
                      {/* Revenue bar */}
                      <div style={{marginTop:5}}> 
                        <div style={{height:4,borderRadius:2,background:C.border,overflow:"hidden",width:"100%"}}>
                          <div style={{height:"100%",borderRadius:2,
                            background:barPct>=95
                              ? `linear-gradient(90deg,${rc},${rc}cc,${rc}88)`
                              : `linear-gradient(90deg,${rc},${rc}88)`,
                            boxShadow:barPct>=95 ? `0 0 8px ${rc}66` : "none",
                            width:`${barPct}%`,transition:"width 0.6s ease"}}/>
                        </div>
                        {data.staff.length>1
                          ? <div style={{fontSize:12,color:rc,fontWeight:600,marginTop:3}}>
                              {Math.round((s.revenue/totalStaffRevenue)*100)}% of total sales
                            </div>
                          : <div style={{fontSize:12,color:C.text3,fontWeight:500,marginTop:3}}>
                              Only staff member recorded
                            </div>
                        }
                      </div>
                    </div>

                    {/* Stats */}
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:16,fontWeight:700,color:rc}}>
                        KSh {Number(s.revenue).toLocaleString("en-KE",{maximumFractionDigits:0})}
                      </div>
                      <div style={{fontSize:12,color:C.text3,marginTop:1}}>
                        {s.orders} order{s.orders!==1?"s":""} · avg KSh {Number(s.avgOrder).toLocaleString("en-KE",{maximumFractionDigits:0})}
                      </div>
                    </div>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.text3} strokeWidth={2.5} style={{flexShrink:0,transition:"transform 0.2s",transform:isOpen?"rotate(180deg)":"rotate(0deg)"}}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>

                  {/* Expanded: mini chart */}
                  {isOpen&&(
                    <div style={{padding:"0 14px 14px",borderTop:`1px solid ${C.border}`}}>
                      <div style={{fontSize:13,color:C.text3,margin:"10px 0 8px",fontWeight:600}}>
                        Daily Revenue — {PERIOD_LABELS[period]}
                      </div>
                      {s.timeline&&s.timeline.length>1&&(()=>{
                        const maxV = Math.max(...s.timeline.map(t=>t.sales), 1);
                        return(
                          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:60}}>
                            {s.timeline.map((t,ti)=>(
                              <div key={ti} title={`${t.day}: KSh ${Number(t.sales).toLocaleString("en-KE")}`}
                                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                                {(()=>{
                                const now=new Date();
                                const todayKey=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
                                const fullKey=s.timeline.length===ti+1?todayKey:null; // approximation
                                const isToday = t.day===todayKey.slice(5);
                                return(
                                  <div style={{width:"100%",borderRadius:"3px 3px 0 0",
                                    background:t.sales>0?(isToday?C.green:rc):C.border,
                                    height:`${Math.max(4,(t.sales/maxV)*52)}px`,
                                    transition:"height 0.4s ease",cursor:"pointer",
                                    boxShadow:isToday&&t.sales>0?`0 0 6px ${C.green}66`:"none"}}/>
                                );
                              })()}
                                <span style={{fontSize:9,color:C.text3,whiteSpace:"nowrap"}}>{t.day}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      {/* Detailed stats */}
                      <div className="r-form-2col" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10}}>
                        <div style={{padding:"8px 10px",borderRadius:8,background:C.card,border:`1px solid ${C.border}`}}>
                          <div style={{fontSize:11,color:C.text3,marginBottom:2}}>Total Orders</div>
                          <div style={{fontWeight:700,fontSize:17,color:C.text}}>{s.orders}</div>
                        </div>
                        <div style={{padding:"8px 10px",borderRadius:8,background:C.card,border:`1px solid ${C.border}`}}>
                          <div style={{fontSize:11,color:C.text3,marginBottom:2}}>Avg Order</div>
                          <div style={{fontWeight:700,fontSize:17,color:C.text}}>
                            KSh {Number(s.avgOrder).toLocaleString("en-KE",{maximumFractionDigits:0})}
                          </div>
                        </div>
                      </div>
                      <div style={{fontSize:13,color:C.text3,marginTop:8}}>📧 {s.email||"—"}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

/* ══════════ CROSS-BRANCH REPORT ══════════ */
function AssignUnassignedBanner({unassignedOrders,unassignedRevenue,branches,onDone}){
  const [selectedBranch,setSelectedBranch]=useState("");
  const [assigning,setAssigning]=useState(false);
  const [done,setDone]=useState(false);
  const [err,setErr]=useState("");

  if(done) return(
    <div style={{fontSize:13,color:C.green,background:"rgba(34,197,94,0.08)",
      border:`1px solid ${C.green}44`,borderRadius:8,padding:"8px 12px",marginTop:4,display:"inline-block"}}>
      ✅ Orders successfully assigned to branch
    </div>
  );

  const handleAssign=async()=>{
    if(!selectedBranch){setErr("Please select a branch.");return;}
    setAssigning(true);setErr("");
    try{
      const r=await apiFetch("/api/branches/assign-unassigned",{
        method:"POST",
        body:JSON.stringify({branchId:parseInt(selectedBranch)}),
      });
      const data=await r.json();
      if(r.ok){setDone(true);setTimeout(()=>onDone&&onDone(),800);}
      else setErr(data.error||"Failed.");
    }catch{setErr("Cannot connect.");}
    setAssigning(false);
  };

  return(
    <div style={{marginTop:6,background:"rgba(245,158,11,0.06)",border:`1px solid ${C.amber}44`,
      borderRadius:10,padding:"12px 14px"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:200}}>
          <div style={{fontWeight:600,color:C.amber,fontSize:14,marginBottom:2}}>
            ⚠️ {unassignedOrders} order{unassignedOrders!==1?"s":""} · KSh {unassignedRevenue.toLocaleString()} not linked to any branch
          </div>
          <div style={{fontSize:15,color:C.text3}}>
            These were processed without a branch selected. Assign them to the correct branch to fix the chart.
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <Select value={selectedBranch} onChange={e=>setSelectedBranch(e.target.value)}
            style={{fontSize:14,padding:"6px 10px",minWidth:130}}>
            <option value="">Select branch…</option>
            {branches.map(b=>(
              <option key={b.id||b.branchId} value={b.id||b.branchId}>{b.location?`${b.name||b.branchName} · ${b.location}`:b.name||b.branchName}</option>
            ))}
          </Select>
          <button onClick={handleAssign} disabled={assigning||!selectedBranch}
            style={{padding:"6px 14px",borderRadius:8,border:"none",
              background:C.amber,color:"#000",fontWeight:700,fontSize:14,
              cursor:assigning||!selectedBranch?"not-allowed":"pointer",
              opacity:assigning||!selectedBranch?0.6:1}}>
            {assigning?"…":"Assign All"}
          </button>
        </div>
      </div>
      {err&&<div style={{fontSize:15,color:C.red,marginTop:6}}>⚠️ {err}</div>}
    </div>
  );
}


function CrossBranchReport({perms}){
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [showReassign,setShowReassign]=useState(false);
  const [unassignedOrders,setUnassignedOrders]=useState([]);
  const [reassignBranch,setReassignBranch]=useState("");
  const [selectedOrderIds,setSelectedOrderIds]=useState([]);
  const [reassigning,setReassigning]=useState(false);
  const [reassignToast,setReassignToast]=useState(null);
  const [branches,setBranches]=useState([]);

  const fetchReport = useCallback(()=>{
    if(!perms||perms.badge==="CASHIER"){ setLoading(false); return; }
    Promise.all([
      apiFetch("/api/branches/cross-report?days=30").then(r=>r.ok?r.json():Promise.reject(r.status)),
      apiFetch("/api/branches").then(r=>r.ok?r.json():[]).catch(()=>[]),
    ])
      .then(([d,br])=>{ setResult(d); setBranches(br); })
      .catch((e)=>{
        if(e===403||e===401) setError("");
        else setError("Cross-branch data unavailable.");
      })
      .finally(()=>setLoading(false));
  },[perms]);

  useEffect(()=>{ fetchReport(); },[fetchReport]);

  // Auto-refresh every 30 seconds so DB changes show without page reload
  useEffect(()=>{
    const id=setInterval(()=>fetchReport(),30000);
    return()=>clearInterval(id);
  },[fetchReport]);

  const [refreshing,setRefreshing]=useState(false);
  const handleManualRefresh=()=>{
    setRefreshing(true);
    Promise.all([
      apiFetch("/api/branches/cross-report?days=30").then(r=>r.ok?r.json():null),
      apiFetch("/api/branches").then(r=>r.ok?r.json():[]).catch(()=>[]),
    ]).then(([d,br])=>{if(d){setResult(d);setBranches(br);}}).finally(()=>setRefreshing(false));
  };

  const openReassign=async()=>{
    setShowReassign(true);
    setSelectedOrderIds([]);
    const [ordersRes,branchRes]=await Promise.all([
      apiFetch("/api/branches/unassigned-orders").then(r=>r.ok?r.json():[]),
      apiFetch("/api/branches").then(r=>r.ok?r.json():[]),
    ]);
    setUnassignedOrders(Array.isArray(ordersRes)?ordersRes:[]);
    setBranches(Array.isArray(branchRes)?branchRes:[]);
  };

  const doReassign=async()=>{
    if(!selectedOrderIds.length||!reassignBranch) return;
    setReassigning(true);
    try{
      const r=await apiFetch("/api/branches/reassign-orders",{
        method:"POST",
        body:JSON.stringify({orderIds:selectedOrderIds,branchId:parseInt(reassignBranch)}),
      });
      const d=await r.json();
      if(r.ok){
        setReassignToast({type:"ok",msg:d.message});
        setShowReassign(false);
        setSelectedOrderIds([]);
        setReassignBranch("");
        fetchReport(); // refresh chart
      } else {
        setReassignToast({type:"err",msg:d.error||"Failed."});
      }
    }catch{ setReassignToast({type:"err",msg:"Cannot connect to server."}); }
    setReassigning(false);
    setTimeout(()=>setReassignToast(null),4000);
  };

  if(loading) return null;
  if(error) return(
    <Card style={{marginTop:12,padding:20}}>
      <div style={{fontWeight:600,fontSize:17,marginBottom:4}}>🏪 Cross-Branch Performance</div>
      <div style={{fontSize:14,color:C.text3,textAlign:"center",padding:"20px 0"}}>{error}</div>
    </Card>
  );
  if(!result) return null;

  // Rename destructured vars to avoid conflict with state variables
  const {
    branches:   branchRows=[],
    unassignedOrders:   apiUnassignedOrders=0,
    unassignedRevenue:  apiUnassignedRevenue=0,
    totalOrderCount:    apiTotalOrderCount=0,
    hasUnassigned:      apiHasUnassigned=false,
  }=result;

  // Build sorted branch list including unassigned bucket
  const byBranch={};
  branchRows.forEach(r=>{
    const bLabel = r.branchLocation ? `${r.branchName} · ${r.branchLocation}` : r.branchName;
    byBranch[bLabel]={revenue:Number(r.revenue)||0,orders:Number(r.orders)||0,isHQ:!!r.isHQ};
  });
  // Add unassigned bucket if it has sales
  if(apiUnassignedRevenue>0||apiUnassignedOrders>0){
    byBranch["Unassigned"]={revenue:apiUnassignedRevenue,orders:apiUnassignedOrders};
  }
  const sorted=Object.entries(byBranch).sort((a,b)=>b[1].revenue-a[1].revenue);
  const totalRevenue=sorted.reduce((s,[,v])=>s+v.revenue,0);
  const maxRev=sorted[0]?.[1]?.revenue||1;

  // No branches set up — hide the entire card
  if(!branchRows.length) return null;

  return(
    <Card style={{marginTop:12,padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontWeight:700,fontSize:17,letterSpacing:"-0.01em"}}>🏪 Cross-Branch Performance</div>
          <div style={{fontSize:15,color:C.text3,marginTop:2}}>Last 30 days · all locations{totalRevenue===0&&<span style={{marginLeft:8,color:C.amber,fontWeight:600}}>· No sales recorded yet</span>}</div>
          {apiHasUnassigned&&<AssignUnassignedBanner
            unassignedOrders={apiUnassignedOrders}
            unassignedRevenue={apiUnassignedRevenue}
            branches={branches}  // all active branches, not just ones with sales
            onDone={()=>{
              // Re-fetch after reassignment
              setResult(null);setLoading(true);
              apiFetch("/api/branches/cross-report?days=30")
                .then(r=>r.ok?r.json():null)
                .then(d=>{if(d) setResult(d);})
                .finally(()=>setLoading(false));
            }}
          />}
        </div>
        <button onClick={handleManualRefresh} disabled={refreshing}
          style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",
            borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",
            color:C.text2,fontSize:14,fontWeight:600,cursor:refreshing?"not-allowed":"pointer",
            opacity:refreshing?0.6:1,transition:"all 0.15s",flexShrink:0}}
          onMouseEnter={e=>{if(!refreshing)e.currentTarget.style.background="rgba(255,255,255,0.05)";}}
          onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
          <span style={{display:"inline-block",animation:refreshing?"spin 0.8s linear infinite":"none",
            width:14,height:14,fontSize:14,lineHeight:1}}>🔄</span>
          {refreshing?"Refreshing…":"Refresh"}
        </button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {sorted.map(([name,stats],i)=>{
          // Show % of TOTAL revenue (not % of max) so bars reflect real share
          // Give a minimum visual width of 4% so tiny branches still show a sliver
          const pct = totalRevenue>0 ? Math.max(4, Math.round((stats.revenue/totalRevenue)*100)) : 4;
          const colors=[C.amber,C.blue,C.green,C.purple,"#06b6d4","#ec4899"];
          const col=colors[i%colors.length];
          const sharePct = totalRevenue>0 ? Math.round((stats.revenue/totalRevenue)*100) : 0;
          return(
            <div key={name}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:2,background:col,flexShrink:0}}/>
                  <span style={{fontWeight:600,fontSize:15}}>
                    {name}
                    {sorted[i][1].isHQ&&<span style={{fontSize:10,fontWeight:700,color:C.amber,background:C.amberGlow,padding:"1px 6px",borderRadius:20,marginLeft:6}}>HQ</span>}
                  </span>
                  <span style={{fontSize:15,color:C.text3}}>{stats.orders} order{stats.orders!==1?"s":""}</span>
                  {sorted.length>1
                    ? <span style={{fontSize:12,color:col,fontWeight:600,background:col+"18",padding:"1px 7px",borderRadius:20}}>{sharePct}%</span>
                    : <span style={{fontSize:12,color:C.text3,fontWeight:500,background:"rgba(255,255,255,0.04)",padding:"1px 7px",borderRadius:20}}>Only branch</span>
                  }
                </div>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:15,fontWeight:500,color:col}}>{ksh(stats.revenue)}</span>
              </div>
              <div style={{height:6,borderRadius:3,background:C.border,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:3,
                  background:pct>=95 ? `linear-gradient(90deg,${col},${col}cc)` : col,
                  boxShadow:pct>=95 ? `0 0 6px ${col}66` : "none",
                  width:`${pct}%`,transition:"width 0.6s ease"}}/>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ══════════ CREATE STAFF FORM ══════════ */
function CreateStaffForm({branches=[]}){
  const [sFirst,setSFirst]=useState("");
  const [sLast,setSLast]=useState("");
  const [sEmail,setSEmail]=useState("");
  const [sPass,setSPass]=useState("");
  const [role,setRole]=useState("cashier");
  const [branchId,setBranchId]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");

  const roles=[
    {id:"cashier",icon:"🏪",label:"Cashier",desc:"POS only"},
    {id:"manager",icon:"📊",label:"Manager",desc:"POS + Inventory + Reports"},
    {id:"admin",  icon:"⚙️",label:"Admin",  desc:"Full access — no branch lock"},
  ];

  const handleCreate=async()=>{
    if(!sFirst.trim()||!sEmail.includes("@")||sPass.length<8)
      return setError("Please fill all required fields correctly (min 8-char password).");
    setLoading(true);setError("");
    try{
      const body={name:`${sFirst.trim()} ${sLast.trim()}`,email:sEmail,password:sPass,role};
      if(branchId&&role!=="admin") body.branchId=+branchId;
      const res=await apiFetch("/api/auth/signup",{method:"POST",body:JSON.stringify(body)});
      const data=await res.json();
      if(!res.ok) setError(data.error||"Failed.");
      else{
        // Admin-created accounts are immediately active (data.user exists)
        // Self-signups return {pending:true} but admin uses this form so data.user always exists
        const displayName = data.user?.name || `${sFirst.trim()} ${sLast.trim()}`;
        const branchSuffix = branchId && role!=="admin" ? " · " + (branches.find(b=>b.id===+branchId)?.name||"branch") : "";
        setSuccess("✅ " + displayName + " (" + role + branchSuffix + ") created!");
        setSFirst("");setSLast("");setSEmail("");setSPass("");setRole("cashier");setBranchId("");
      }
    }catch(e){setError("Error: " + (e?.message||"Unknown error. Check backend console."));}
    setLoading(false);
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      {/* Role picker */}
      <div>
        <div style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:8}}>Account Role</div>
        <div style={{display:"flex",gap:8}}>
          {roles.map(r=>(
            <div key={r.id} onClick={()=>setRole(r.id)}
              style={{flex:1,padding:"10px 8px",textAlign:"center",borderRadius:10,cursor:"pointer",transition:"all 0.2s",
                background:role===r.id?PERMISSIONS[r.id].color+"15":C.card,
                border:`1.5px solid ${role===r.id?PERMISSIONS[r.id].color:C.border}`}}>
              <div style={{fontSize:18,marginBottom:3}}>{r.icon}</div>
              <div style={{fontSize:13,fontWeight:700,color:role===r.id?PERMISSIONS[r.id].color:C.text2}}>{r.label}</div>
              <div style={{fontSize:14,color:C.text3}}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Branch assignment */}
      {role!=="admin"&&branches.length>0&&(
        <div>
          <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>🏪 Assign to Branch</label>
          <Select value={branchId} onChange={e=>setBranchId(e.target.value)} style={{width:"100%"}}>
            <option value="">— No branch (HQ / floating) —</option>
            {branches.map(b=><option key={b.id} value={b.id}>{branchLabel(b)}</option>)}
          </Select>
          <div style={{fontSize:15,color:C.text3,marginTop:4}}>Their JWT will carry this branch ID — all their sales auto-tag to it.</div>
        </div>
      )}

      {/* Name row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div>
          <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>First Name *</label>
          <Input value={sFirst} onChange={e=>setSFirst(e.target.value)} placeholder="First"/>
        </div>
        <div>
          <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Last Name</label>
          <Input value={sLast} onChange={e=>setSLast(e.target.value)} placeholder="Last"/>
        </div>
      </div>
      <div>
        <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Email *</label>
        <Input type="email" value={sEmail} onChange={e=>setSEmail(e.target.value)} placeholder="staff@starmart.co.ke"/>
      </div>
      <div>
        <label style={{fontSize:15,color:C.text2,display:"block",marginBottom:4}}>Password * <span style={{color:C.text3,fontWeight:400}}>(min 8 characters)</span></label>
        <Input type="password" value={sPass} onChange={e=>setSPass(e.target.value)} placeholder="Min. 8 characters"/>
      </div>
      {error&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red}}>⚠️ {error}</div>}
      {success&&<div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.green}}>{success}</div>}
      <Btn onClick={handleCreate} style={{width:"100%",justifyContent:"center"}} disabled={loading}>
        {loading?"Creating…":"Create Staff Account"}
      </Btn>
    </div>
  );
}

/* ══════════ OFFLINE BANNER ══════════ */
function OfflineBanner({online,queueCount,syncing}){
  const [visible,setVisible]=useState(false);
  const [fadeOut,setFadeOut]=useState(false);
  const prevOnline=useRef(online);

  useEffect(()=>{
    if(!online){
      setVisible(true);setFadeOut(false);
    } else if(prevOnline.current===false){
      // Just came back online — show "synced" briefly then fade
      setVisible(true);setFadeOut(false);
      const t=setTimeout(()=>{setFadeOut(true);setTimeout(()=>setVisible(false),600);},3500);
      return()=>clearTimeout(t);
    } else if(!queueCount){
      setVisible(false);
    }
    prevOnline.current=online;
  },[online,queueCount]);

  if(!visible) return null;

  const bg    = online ? "rgba(34,197,94,0.12)"    : "rgba(245,158,11,0.10)";
  const bord  = online ? "rgba(34,197,94,0.25)"    : "rgba(245,158,11,0.25)";
  const col   = online ? C.green                   : C.amber;
  const msg   = online
    ? syncing
      ? `🔄 Syncing ${queueCount} offline order${queueCount!==1?"s":""}…`
      : `✅ Back online — all orders synced successfully`
    : queueCount>0
      ? `📡 Offline — ${queueCount} order${queueCount!==1?"s":""}  queued, will sync automatically`
      : `📡 Offline — new sales will be saved locally and synced when reconnected`;

  return(
    <div style={{background:bg,borderBottom:`1px solid ${bord}`,padding:"6px 24px",
      display:"flex",alignItems:"center",gap:10,fontSize:14,color:col,fontWeight:600,
      flexShrink:0,transition:"opacity 0.6s",opacity:fadeOut?0:1}}>
      <span style={{width:7,height:7,borderRadius:"50%",background:col,flexShrink:0,
        animation:online?"none":"pulse 2s infinite"}}/>
      {msg}
      {queueCount>0&&!online&&<span style={{marginLeft:"auto",padding:"2px 8px",borderRadius:20,
        background:C.amber+"25",border:`1px solid ${C.amber}44`,fontSize:14,fontWeight:700}}>
        {queueCount} QUEUED
      </span>}
    </div>
  );
}

/* ══════════ BRANCH SELECTOR ══════════ */
function BranchSelector({branches,activeBranch,onBranchChange,user}){
  const [open,setOpen]=useState(false);
  const ref=useRef(null);

  // Close on outside click
  useEffect(()=>{
    const h=(e)=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);

  // Auto-lock cashier to their assigned branch — MUST be before any early return
  const isCashierLocked = user.role==="cashier" && !!user.branchId &&
    branches.some(b=>b.id===user.branchId);

  useEffect(()=>{
    if(!isCashierLocked || !user.branchId || !branches.length) return;
    const assigned = branches.find(b=>b.id===user.branchId);
    if(assigned && activeBranch?.id !== assigned.id) onBranchChange(assigned);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isCashierLocked, user.branchId, branches.length]);

  if(!branches.length) return null;

  const canSwitch = !isCashierLocked;

  return(
    <div ref={ref} style={{position:"relative"}}>
      <button onClick={()=>canSwitch&&setOpen(o=>!o)}
        style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:7,
          border:`1px solid ${activeBranch?C.blue+"44":C.border}`,
          background:activeBranch?C.blueGlow:C.card,
          color:activeBranch?C.blue:C.text2,
          cursor:canSwitch?"pointer":"default",
          fontSize:15,fontWeight:600,transition:"all 0.15s",whiteSpace:"nowrap"}}>
        🏪 {activeBranch ? branchLabel(activeBranch) : "Select Branch"}
        {canSwitch&&<svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points={open?"18 15 12 9 6 15":"6 9 12 15 18 9"}/></svg>}
        {isCashierLocked&&<svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
      </button>
      {open&&(
        <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,
          background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:10,
          padding:6,minWidth:220,boxShadow:"0 12px 40px rgba(0,0,0,0.5)",zIndex:600,
          animation:"floatUp 0.15s ease both"}}>
          <div style={{padding:"6px 12px 8px",borderBottom:`1px solid ${C.border}`,marginBottom:4}}>
            <div style={{fontSize:12,fontWeight:700,color:C.text3,letterSpacing:"0.06em",textTransform:"uppercase"}}>Select Branch</div>
          </div>
          {branches.map(b=>(
            <button key={b.id} onClick={()=>{onBranchChange(b);setOpen(false);}}
              style={{width:"100%",display:"flex",alignItems:"center",gap:8,
                padding:"9px 12px",
                background:activeBranch?.id===b.id?C.blueGlow:"transparent",
                border:"none",borderRadius:7,cursor:"pointer",textAlign:"left",
                color:activeBranch?.id===b.id?C.blue:C.text,
                fontSize:14,fontWeight:activeBranch?.id===b.id?600:400,transition:"all 0.15s"}}
              onMouseEnter={e=>{if(activeBranch?.id!==b.id)e.currentTarget.style.background="rgba(255,255,255,0.04)";}}
              onMouseLeave={e=>{if(activeBranch?.id!==b.id)e.currentTarget.style.background="transparent";}}>
              <div style={{width:7,height:7,borderRadius:"50%",
                background:activeBranch?.id===b.id?C.blue:C.text3,flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  {b.name}
                  {b.isHQ&&<span style={{fontSize:10,fontWeight:700,color:C.amber,background:C.amberGlow,padding:"1px 6px",borderRadius:20}}>HQ</span>}
                  {user.branchId===b.id&&<span style={{fontSize:10,fontWeight:700,color:C.green,background:"rgba(34,197,94,0.1)",padding:"1px 6px",borderRadius:20}}>Assigned</span>}
                </div>
                {b.location&&<div style={{fontSize:12,color:C.text3}}>{b.location}</div>}
              </div>
              {activeBranch?.id===b.id&&<span style={{marginLeft:"auto",fontSize:14,color:C.blue,flexShrink:0}}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/* ══════════ STOCK TRANSFER MODAL ══════════ */
// Managers REQUEST a transfer (status=pending).
// Admins APPROVE or REJECT from the Transfers panel.
function StockTransferModal({product,branches,currentBranch,onClose,onDone}){
  const [toId,setToId]=useState("");
  const [qty,setQty]=useState(1);
  const [notes,setNotes]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  const destBranches=branches.filter(b=>b.id!==(currentBranch?.id));

  const handleRequest=async()=>{
    if(!toId) return setError("Select a destination branch.");
    if(qty<1||qty>product.stock) return setError(`Quantity must be between 1 and ${product.stock} (available at source branch).`);
    setLoading(true);setError("");
    try{
      const r=await apiFetch("/api/branches/transfer",{
        method:"POST",
        body:JSON.stringify({fromBranchId:currentBranch?.id||1,toBranchId:+toId,productId:product.id,quantity:qty,notes:notes||null}),
      });
      const data=await r.json();
      if(!r.ok){setError(data.error||"Request failed.");}
      else{onDone(data.message, data.status);}
    }catch{setError(getOfflineError("Cannot connect to server."));}
    setLoading(false);
  };

  return(
    <Modal title="Request Stock Transfer" onClose={onClose}>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
        background:"rgba(255,255,255,0.03)",borderRadius:10,marginBottom:18}}>
        <div style={{width:44,height:44,borderRadius:10,overflow:"hidden",flexShrink:0,
          background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>
          {product.image?<img src={product.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:product.emoji||"📦"}
        </div>
        <div>
          <div style={{fontWeight:600,fontSize:16}}>{product.name}</div>
          <div style={{fontSize:15,color:C.text3}}>{product.sku} · <span style={{color:C.green}}>{product.stock} available at {currentBranch?.name||"this branch"}</span></div>
        </div>
      </div>
      <div style={{background:"rgba(245,158,11,0.07)",border:`1px solid ${C.amber}33`,borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:14,color:C.text2}}>
        📋 As Manager, you are submitting a <strong style={{color:C.amber}}>transfer request</strong>. An Admin must approve it before any stock physically moves between branches.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div>
          <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>From Branch</label>
          <div style={{background:"#0D1117",border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 12px",fontSize:15,color:C.text3}}>
            {branchLabel(currentBranch)||"Main Branch"}
          </div>
        </div>
        <div>
          <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>To Branch *</label>
          <Select value={toId} onChange={e=>setToId(e.target.value)} style={{width:"100%"}}>
            <option value="">Select branch…</option>
            {destBranches.map(b=><option key={b.id} value={b.id}>{branchLabel(b)}</option>)}
          </Select>
        </div>
      </div>
      <div style={{marginBottom:12}}>
        <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Quantity *</label>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={()=>setQty(q=>Math.max(1,q-1))} style={{width:34,height:34,borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:18,fontWeight:600}}>−</button>
          <Input type="number" value={qty} onChange={e=>setQty(Math.max(1,Math.min(product.stock,+e.target.value)))} style={{textAlign:"center",width:80,fontFamily:"DM Mono,monospace",fontSize:18}}/>
          <button onClick={()=>setQty(q=>Math.min(product.stock,q+1))} style={{width:34,height:34,borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:18,fontWeight:600}}>+</button>
          <span style={{fontSize:15,color:C.text3}}>of {product.stock} available</span>
        </div>
      </div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Notes (optional)</label>
        <Input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. Weekly restocking"/>
      </div>
      {error&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red,marginBottom:12}}>⚠️ {error}</div>}
      <div style={{display:"flex",gap:8}}>
        <Btn variant="ghost" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
        <Btn onClick={handleRequest} disabled={loading} style={{flex:2,justifyContent:"center",background:"linear-gradient(135deg,#6366F1,#4F46E5)"}}>
          {loading
            ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Sending…</span>
            :`📤 Send Request (Admin will approve)`}
        </Btn>
      </div>
    </Modal>
  );
}


/* ══════════ BRANCH MANAGEMENT (inside Settings) ══════════ */
/* ══════════ TRANSFER APPROVAL QUEUE ══════════ */
function TransferApprovalQueue({currentUser}){
  const [transfers,setTransfers]=useState([]);
  const [loading,setLoading]=useState(true);
  const [toast,setToast]=useState(null);
  const [acting,setActing]=useState(null); // transferId being actioned

  const showToast=(type,msg)=>{setToast({type,msg});setTimeout(()=>setToast(null),3500);};

  const fetchPending=useCallback(async()=>{
    setLoading(true);
    try{
      const r=await apiFetch("/api/branches/transfers?status=pending&limit=50");
      if(r.ok){ const data=await r.json(); setTransfers(Array.isArray(data)?data:[]); }
    }catch{}
    setLoading(false);
  },[]);

  useEffect(()=>{ fetchPending(); },[fetchPending]);

  const handleAction=async(id,action)=>{
    setActing(id);
    try{
      const r=await apiFetch(`/api/branches/transfer/${id}/${action}`,{method:"POST"});
      const data=await r.json();
      if(r.ok){
        showToast("ok",data.message);
        setTransfers(ts=>ts.filter(t=>t.id!==id));
      } else showToast("err",data.error||"Action failed.");
    }catch{showToast("err","Cannot connect to server.");}
    setActing(null);
  };

  // Only admins see the approval queue
  if(currentUser?.role!=="admin") return null;

  return(
    <div style={{marginTop:24}}>
      {toast&&<div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,
        padding:"11px 20px",borderRadius:10,fontSize:15,fontWeight:600,
        background:toast.type==="ok"?`${C.green}18`:`${C.red}18`,
        border:`1px solid ${toast.type==="ok"?C.green:C.red}44`,
        color:toast.type==="ok"?C.green:C.red,
        boxShadow:"0 8px 32px rgba(0,0,0,0.5)",animation:"fadeIn 0.2s ease"}}>
        {toast.type==="ok"?"✅":"⚠️"} {toast.msg}
      </div>}

      <Card style={{padding:24,maxWidth:700}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,background:"rgba(245,158,11,0.12)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📋</div>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontWeight:700,fontSize:16}}>Transfer Approval Queue</div>
                {transfers.length>0&&<span style={{fontSize:13,fontWeight:700,padding:"2px 8px",borderRadius:20,
                  background:"rgba(245,158,11,0.15)",color:C.amber,border:`1px solid ${C.amber}33`}}>
                  {transfers.length} pending
                </span>}
              </div>
              <div style={{fontSize:15,color:C.text3}}>Approve or reject manager stock transfer requests</div>
            </div>
          </div>
          <button onClick={fetchPending} style={{background:C.card,border:`1px solid ${C.border}`,
            borderRadius:7,color:C.text2,cursor:"pointer",padding:"6px 10px",fontSize:15}}>🔄</button>
        </div>

        {loading&&<div style={{textAlign:"center",padding:24}}>
          <span style={{width:24,height:24,border:`3px solid ${C.border}`,borderTopColor:C.amber,
            borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/>
        </div>}

        {!loading&&transfers.length===0&&(
          <div style={{textAlign:"center",padding:"20px 0",color:C.text3,fontSize:15}}>
            ✅ No pending transfer requests
          </div>
        )}

        {!loading&&transfers.map(t=>(
          <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
            borderRadius:10,background:"rgba(245,158,11,0.04)",border:`1px solid ${C.amber}22`,marginBottom:8}}>
            {/* Product emoji */}
            <div style={{width:38,height:38,borderRadius:9,background:"rgba(255,255,255,0.04)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
              {t.product.emoji||"📦"}
            </div>
            {/* Details */}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:15}}>{t.product.name}
                <span style={{fontFamily:"'DM Mono',monospace",color:C.amber,marginLeft:8,fontSize:14}}>×{t.quantity}</span>
              </div>
              <div style={{fontSize:15,color:C.text3,marginTop:2}}>
                <span style={{color:C.red}}>{branchLabel(t.fromBranch)}</span>
                <span style={{margin:"0 6px"}}>→</span>
                <span style={{color:C.green}}>{branchLabel(t.toBranch)}</span>
                <span style={{marginLeft:8,color:C.text3}}>by {t.createdBy?.name||"Unknown"}</span>
              </div>
              {t.notes&&<div style={{fontSize:14,color:C.text3,marginTop:2,fontStyle:"italic"}}>"{t.notes}"</div>}
            </div>
            {/* Date */}
            <div style={{fontSize:14,color:C.text3,flexShrink:0}}>
              {new Date(t.createdAt).toLocaleDateString("en-KE")}
            </div>
            {/* Actions */}
            <div style={{display:"flex",gap:6,flexShrink:0}}>
              <button
                onClick={()=>handleAction(t.id,"approve")}
                disabled={acting===t.id}
                style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${C.green}44`,
                  background:"rgba(34,197,94,0.1)",color:C.green,cursor:"pointer",
                  fontSize:13,fontWeight:700,transition:"all 0.15s",opacity:acting===t.id?0.5:1}}
                onMouseEnter={e=>e.currentTarget.style.background="rgba(34,197,94,0.2)"}
                onMouseLeave={e=>e.currentTarget.style.background="rgba(34,197,94,0.1)"}>
                {acting===t.id?"…":"✅ Approve"}
              </button>
              <button
                onClick={()=>handleAction(t.id,"reject")}
                disabled={acting===t.id}
                style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${C.red}33`,
                  background:"transparent",color:C.red,cursor:"pointer",
                  fontSize:13,fontWeight:700,transition:"all 0.15s",opacity:acting===t.id?0.5:1}}
                onMouseEnter={e=>e.currentTarget.style.background=C.redGlow}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ══════════ STAFF MANAGEMENT ══════════ */
function StaffManagement({currentUser}){
  const [staff,setStaff]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [roleTarget,setRoleTarget]=useState(null);
  const [branchTarget,setBranchTarget]=useState(null);
  const [branches,setBranches]=useState([]);
  const [actionLoading,setActionLoading]=useState(false);
  const [toast,setToast]=useState(null);
  // Pending approvals
  const [pendingUsers,setPendingUsers]=useState([]);
  const [pendingLoading,setPendingLoading]=useState(false);
  // OTP delete flow for admin accounts
  const [otpDeleteTarget,setOtpDeleteTarget]=useState(null); // user obj
  const [otpSent,setOtpSent]=useState(false);
  const [otpInput,setOtpInput]=useState("");
  const [otpError,setOtpError]=useState("");
  const [otpLoading,setOtpLoading]=useState(false);
  const [otpDevCode,setOtpDevCode]=useState(null);

  const showToast=(type,msg)=>{ setToast({type,msg}); setTimeout(()=>setToast(null),3500); };

  const fetchStaff=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const r=await apiFetch("/api/users");
      const data=await r.json();
      if(!r.ok) throw new Error(data.error||"Failed to load staff");
      setStaff(data);
    }catch(e){setError(getOfflineError(e.message));}
    setLoading(false);
  },[]);

  useEffect(()=>{ fetchStaff(); },[fetchStaff]);

  // Auto-refresh staff list every 30s (role/branch changes from another admin)
  useEffect(()=>{
    const t = setInterval(()=>{ if(navigator.onLine) fetchStaff(); }, 30000);
    return ()=>clearInterval(t);
  },[fetchStaff]);

  const fetchPendingUsers=useCallback(async()=>{
    setPendingLoading(true);
    try{
      const r=await apiFetch("/api/users/pending");
      const data=await r.json();
      if(r.ok) setPendingUsers(data);
    }catch{}
    setPendingLoading(false);
  },[]);

  useEffect(()=>{ fetchPendingUsers(); },[fetchPendingUsers]);

  // Poll pending approvals every 20s so admin sees new signups without refreshing
  useEffect(()=>{
    const t = setInterval(()=>{ if(navigator.onLine) fetchPendingUsers(); }, 20000);
    return ()=>clearInterval(t);
  },[fetchPendingUsers]);

  const handleApprove=async(u)=>{
    setActionLoading(true);
    try{
      const r=await apiFetch(`/api/users/${u.id}/approve`,{method:"POST"});
      const d=await r.json();
      if(!r.ok) showToast("err",d.error||"Failed to approve.");
      else{ showToast("ok",d.message); fetchPendingUsers(); fetchStaff(); }
    }catch{ showToast("err","Cannot connect to server."); }
    setActionLoading(false);
  };

  const handleReject=async(u)=>{
    setActionLoading(true);
    try{
      const r=await apiFetch(`/api/users/${u.id}/reject`,{method:"POST"});
      const d=await r.json();
      if(!r.ok) showToast("err",d.error||"Failed to reject.");
      else{ showToast("ok",d.message); fetchPendingUsers(); }
    }catch{ showToast("err","Cannot connect to server."); }
    setActionLoading(false);
  };

  const handleRequestOtp=async(u)=>{
    setOtpDeleteTarget(u); setOtpSent(false); setOtpInput(""); setOtpError(""); setOtpDevCode(null);
    setOtpLoading(true);
    try{
      const r=await apiFetch(`/api/users/${u.id}/delete-otp`,{method:"POST"});
      const d=await r.json();
      if(!r.ok){ setOtpError(d.error||"Failed to send OTP."); setOtpLoading(false); return; }
      setOtpSent(true);
      if(d.devOtp) setOtpDevCode(d.devOtp);
      showToast("ok", d.message);
    }catch{ setOtpError("Cannot connect to server."); }
    setOtpLoading(false);
  };

  const handleOtpDelete=async()=>{
    if(!otpInput.trim()){ setOtpError("Enter the OTP code."); return; }
    setOtpLoading(true); setOtpError("");
    try{
      const r=await apiFetch(`/api/users/${otpDeleteTarget.id}`,{
        method:"DELETE",
        body:JSON.stringify({otp:otpInput.trim()}),
      });
      const d=await r.json();
      if(!r.ok){ setOtpError(d.error||"Deletion failed."); setOtpLoading(false); return; }
      showToast("ok",d.message||"Admin account deleted.");
      setOtpDeleteTarget(null); setOtpInput(""); setOtpSent(false);
      if(d.wasSelf){ localStorage.removeItem("starmart_token"); setTimeout(()=>window.location.reload(),1200); }
      else fetchStaff();
    }catch{ setOtpError("Cannot connect to server."); }
    setOtpLoading(false);
  };

  // Load branches for the assignment dropdown
  useEffect(()=>{
    apiFetch("/api/branches").then(r=>r.ok?r.json():null).then(data=>{ if(data) setBranches(data); }).catch(()=>{});
  },[]);

  const handleBranchAssign=async()=>{
    if(!branchTarget) return;
    setActionLoading(true);
    try{
      const body = branchTarget.branchId ? {branchId:+branchTarget.branchId} : {branchId:null};
      const r=await apiFetch(`/api/users/${branchTarget.user.id}/branch`,{method:"PATCH",body:JSON.stringify(body)});
      const data=await r.json();
      if(!r.ok){ showToast("err",data.error||"Failed to assign branch."); }
      else{
        const branchName = branchTarget.branchId
          ? branches.find(b=>b.id===+branchTarget.branchId)?.name||"branch"
          : "no branch";
        showToast("ok",`${branchTarget.user.name} assigned to ${branchName}.`);
        await fetchStaff();
      }
    }catch{ showToast("err","Cannot connect to server."); }
    setActionLoading(false);
    setBranchTarget(null);
  };

  const handleDelete=async()=>{
    if(!deleteConfirm) return;
    setActionLoading(true);
    // Optimistic: remove from list immediately so UI feels instant
    setStaff(prev=>prev.filter(s=>s.id!==deleteConfirm.id));
    try{
      const r=await apiFetch(`/api/users/${deleteConfirm.id}`,{method:"DELETE"});
      const data=await r.json();
      if(!r.ok){
        // Roll back optimistic removal if it failed
        await fetchStaff();
        showToast("err",data.error||"Delete failed.");
      } else {
        if(data.wasSelf){
          localStorage.removeItem("starmart_token");
          setTimeout(()=>window.location.reload(),1200);
          showToast("ok","Account deleted. Logging out…");
        } else {
          showToast("ok",data.message||`${deleteConfirm.name} deleted.`);
          // Full refresh to confirm DB state matches UI
          await fetchStaff();
        }
      }
    }catch{
      await fetchStaff(); // restore on network error
      showToast("err","Cannot connect to server.");
    }
    setActionLoading(false);
    setDeleteConfirm(null);
  };

  const handleRoleChange=async()=>{
    if(!roleTarget) return;
    setActionLoading(true);
    try{
      const r=await apiFetch(`/api/users/${roleTarget.user.id}/role`,{method:"PATCH",body:JSON.stringify({role:roleTarget.newRole})});
      const data=await r.json();
      if(!r.ok){ showToast("err",data.error||"Role change failed."); }
      else{ showToast("ok",`${roleTarget.user.name} is now a ${roleTarget.newRole}`); await fetchStaff(); }
    }catch{ showToast("err","Cannot connect to server."); }
    setActionLoading(false);
    setRoleTarget(null);
  };

  const ROLES=[
    {id:"cashier",icon:"🏪",label:"Cashier",color:C.blue},
    {id:"manager",icon:"📊",label:"Manager",color:C.purple},
    {id:"admin",  icon:"⚙️",label:"Admin",  color:C.amber},
  ];

  const roleInfo=(role)=>ROLES.find(r=>r.id===role)||ROLES[0];

  return(
    <div style={{marginTop:24}}>
      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,
          padding:"11px 20px",borderRadius:10,fontSize:15,fontWeight:600,
          background:toast.type==="ok"?`${C.green}18`:`${C.red}18`,
          border:`1px solid ${toast.type==="ok"?C.green:C.red}44`,
          color:toast.type==="ok"?C.green:C.red,
          boxShadow:"0 8px 32px rgba(0,0,0,0.5)",animation:"fadeIn 0.2s ease"}}>
          {toast.type==="ok"?"✅":"⚠️"} {toast.msg}
        </div>
      )}

      <Card style={{padding:24,maxWidth:700}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,background:"rgba(245,158,11,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>👥</div>
            <div>
              <div style={{fontWeight:700,fontSize:16}}>Staff Accounts</div>
              <div style={{fontSize:15,color:C.text3}}>Manage roles and remove staff members</div>
            </div>
          </div>
          <button onClick={fetchStaff} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:7,color:C.text2,cursor:"pointer",padding:"6px 10px",fontSize:15}} title="Refresh">🔄</button>
        </div>

        {loading&&<div style={{textAlign:"center",padding:32}}><span style={{width:28,height:28,border:`3px solid ${C.border}`,borderTopColor:C.amber,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/></div>}
        {error&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red}}>⚠️ {error}</div>}

        {/* ── Pending Approvals ── */}
        {pendingUsers.length>0&&(
          <div style={{marginBottom:20,border:`1.5px solid ${C.amber}44`,borderRadius:12,overflow:"hidden"}}>
            <div style={{background:`rgba(245,158,11,0.08)`,padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:18}}>⏳</span>
                <span style={{fontWeight:700,fontSize:15,color:C.amber}}>Pending Approvals</span>
                <span style={{background:C.amber,color:"#000",fontSize:12,fontWeight:800,padding:"1px 8px",borderRadius:20}}>{pendingUsers.length}</span>
              </div>
              <span style={{fontSize:13,color:C.text3}}>New staff waiting for access</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:0}}>
              {pendingUsers.map(u=>(
                <div key={u.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                  borderTop:`1px solid ${C.border}`,background:"rgba(245,158,11,0.03)"}}>
                  <div style={{width:36,height:36,borderRadius:9,background:C.amber+"20",border:`1.5px solid ${C.amber}44`,
                    display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:15,color:C.amber,flexShrink:0}}>
                    {u.name[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:15}}>{u.name}</div>
                    <div style={{fontSize:13,color:C.text3}}>{u.email}</div>
                    <div style={{fontSize:12,color:C.text3,marginTop:2}}>
                      Registered {new Date(u.createdAt).toLocaleString("en-KE",{dateStyle:"short",timeStyle:"short"})}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button onClick={()=>handleApprove(u)} disabled={actionLoading}
                      style={{padding:"5px 14px",borderRadius:8,border:`1px solid ${C.green}44`,
                        background:`rgba(34,197,94,0.1)`,color:C.green,
                        fontSize:13,fontWeight:700,cursor:"pointer"}}>
                      ✅ Approve
                    </button>
                    <button onClick={()=>handleReject(u)} disabled={actionLoading}
                      style={{padding:"5px 14px",borderRadius:8,border:`1px solid ${C.red}44`,
                        background:`rgba(239,68,68,0.08)`,color:C.red,
                        fontSize:13,fontWeight:700,cursor:"pointer"}}>
                      ✗ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading&&!error&&(
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {staff.map(u=>{
              const ri=roleInfo(u.role);
              const isSelf=u.id===currentUser.id;
              return(
                <div key={u.id} style={{padding:"12px 14px",
                  borderRadius:10,background:isSelf?"rgba(99,102,241,0.06)":"rgba(255,255,255,0.02)",
                  border:`1px solid ${isSelf?C.blue+"33":C.border}`}}>
                  {/* Row 1: Avatar + Name + Badges + Role + Date */}
                  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  {/* Avatar */}
                  <div style={{width:36,height:36,borderRadius:9,background:ri.color+"20",
                    border:`1.5px solid ${ri.color}44`,display:"flex",alignItems:"center",
                    justifyContent:"center",fontWeight:800,fontSize:16,color:ri.color,flexShrink:0}}>
                    {u.name[0].toUpperCase()}
                  </div>
                  {/* Name + email */}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <span style={{fontWeight:700,fontSize:15}}>{u.name}</span>
                      {/* Role badge */}
                      <span style={{fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:20,
                        background:ri.color+"15",border:`1px solid ${ri.color}33`,color:ri.color,flexShrink:0}}>
                        {ri.icon} {ri.label.toUpperCase()}
                      </span>
                      {isSelf&&<span style={{fontSize:12,fontWeight:700,padding:"2px 7px",borderRadius:20,background:C.blue+"20",color:C.blue,flexShrink:0}}>YOU</span>}
                      {u.twoFaEnabled&&<span style={{fontSize:12,fontWeight:700,padding:"2px 7px",borderRadius:20,background:C.green+"18",color:C.green,flexShrink:0}}>2FA</span>}
                    </div>
                    <div style={{fontSize:13,color:C.text3,marginTop:2}}>{u.email}</div>
                    {u.branchName&&<div style={{fontSize:13,color:C.blue,marginTop:1}}>🏪 {u.branchLocation ? `${u.branchName} · ${u.branchLocation}` : u.branchName}</div>}
                    <div style={{fontSize:12,color:C.text3,marginTop:1}}>{new Date(u.createdAt).toLocaleDateString("en-KE")}</div>
                  </div>
                  </div>
                  {/* Row 2: Action buttons */}
                  <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
                    {!isSelf&&(
                      <button
                        onClick={()=>setRoleTarget({user:u,newRole:u.role})}
                        title="Change role"
                        style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${C.border}`,
                          background:"transparent",color:C.text2,cursor:"pointer",fontSize:15,fontWeight:600,
                          transition:"all 0.15s"}}
                        onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.blue;}}
                        onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text2;}}>
                        ✏️ Role
                      </button>
                    )}
                    {!isSelf&&u.role!=="admin"&&(
                      <button
                        onClick={()=>setBranchTarget({user:u,branchId:u.branchId||""})}
                        title="Assign to branch"
                        style={{padding:"5px 10px",borderRadius:7,
                          border:`1px solid ${C.blue}33`,background:"transparent",
                          color:C.blue,fontSize:13,fontWeight:600,cursor:"pointer",
                          transition:"all 0.15s"}}
                        onMouseEnter={e=>{e.currentTarget.style.background=C.blueGlow;}}
                        onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
                        🏪 Branch
                      </button>
                    )}
                    <button
                      onClick={()=> u.role==="admin" ? handleRequestOtp(u) : setDeleteConfirm(u)}
                      title={u.role==="admin"?"Delete admin (requires OTP)":isSelf?"Delete your own account":"Delete account"}
                      style={{padding:"5px 10px",borderRadius:7,
                        border:`1px solid ${isSelf?C.amber+"55":C.red}33`,
                        background:"transparent",
                        color:isSelf?C.amber:C.red,
                        cursor:"pointer",fontSize:15,fontWeight:600,
                        transition:"all 0.15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.background=isSelf?C.amberGlow:C.redGlow;}}
                      onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
                      🗑️{isSelf?" (me)":""}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── DELETE CONFIRM MODAL ── */}
      {deleteConfirm&&(
        <Modal title="Delete Staff Account" onClose={()=>!actionLoading&&setDeleteConfirm(null)}>
          <div style={{textAlign:"center",padding:"8px 0 20px"}}>
            <div style={{width:64,height:64,borderRadius:16,background:C.red+"15",border:`1px solid ${C.red}33`,
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,
              margin:"0 auto 16px"}}>
              {deleteConfirm.name[0].toUpperCase()}
            </div>
            <div style={{fontWeight:700,fontSize:20,marginBottom:4}}>{deleteConfirm.name}</div>
            <div style={{fontSize:14,color:C.text3,marginBottom:6}}>{deleteConfirm.email}</div>
            <div style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,
              background:roleInfo(deleteConfirm.role).color+"15",
              color:roleInfo(deleteConfirm.role).color,
              border:`1px solid ${roleInfo(deleteConfirm.role).color}33`,
              fontSize:16,fontWeight:700,marginBottom:20}}>
              {roleInfo(deleteConfirm.role).icon} {deleteConfirm.role.toUpperCase()}
            </div>
            <div style={{background:C.red+"10",border:`1px solid ${C.red}25`,borderRadius:10,
              padding:"12px 16px",fontSize:14,color:C.text2,lineHeight:1.7,textAlign:"left"}}>
              <div style={{fontWeight:700,color:C.red,marginBottom:6}}>⚠️ This action is permanent</div>
              Their login credentials will be deleted from the database.<br/>
              Past sales orders are preserved for audit purposes.<br/>
              {deleteConfirm.id===currentUser.id
                ? <span style={{color:C.amber,fontWeight:600}}>🔐 You are deleting your own account — you will be logged out immediately and the system will return to first-time setup.</span>
                : deleteConfirm.role==="admin" && <span style={{color:C.amber}}>This is an Admin account. If no other Admins exist, the system will return to first-time setup.</span>
              }
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn variant="ghost" onClick={()=>setDeleteConfirm(null)} disabled={actionLoading} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn variant="danger" onClick={handleDelete} disabled={actionLoading} style={{flex:2,justifyContent:"center"}}>
              {actionLoading
                ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ef444440",borderTopColor:C.red,borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Deleting…</span>
                :"🗑️ Yes, Delete Account"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── CHANGE ROLE MODAL ── */}
      {roleTarget&&(
        <Modal title="Change Role" onClose={()=>!actionLoading&&setRoleTarget(null)}>
          <div style={{marginBottom:16}}>
            <div style={{fontSize:15,color:C.text2,marginBottom:14}}>
              Changing role for <strong style={{color:C.text}}>{roleTarget.user.name}</strong>
            </div>
            <div style={{display:"flex",gap:8}}>
              {ROLES.map(r=>(
                <div key={r.id} onClick={()=>setRoleTarget(t=>({...t,newRole:r.id}))}
                  style={{flex:1,padding:"12px 8px",textAlign:"center",borderRadius:10,cursor:"pointer",
                    transition:"all 0.2s",
                    background:roleTarget.newRole===r.id?r.color+"15":C.card,
                    border:`1.5px solid ${roleTarget.newRole===r.id?r.color:C.border}`}}>
                  <div style={{fontSize:20,marginBottom:4}}>{r.icon}</div>
                  <div style={{fontSize:14,fontWeight:700,color:roleTarget.newRole===r.id?r.color:C.text2}}>{r.label}</div>
                </div>
              ))}
            </div>
          </div>
          {roleTarget.newRole===roleTarget.user.role&&(
            <div style={{fontSize:14,color:C.text3,textAlign:"center",marginBottom:12}}>This is their current role. Select a different role to make a change.</div>
          )}
          <div style={{display:"flex",gap:8}}>
            <Btn variant="ghost" onClick={()=>setRoleTarget(null)} disabled={actionLoading} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn onClick={handleRoleChange} disabled={actionLoading||roleTarget.newRole===roleTarget.user.role} style={{flex:2,justifyContent:"center"}}>
              {actionLoading
                ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Saving…</span>
                :`Set as ${ROLES.find(r=>r.id===roleTarget.newRole)?.label}`}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── Branch Assignment Modal ── */}
      {branchTarget&&(
        <Modal title="Assign Branch" onClose={()=>setBranchTarget(null)}>
          <div style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
              background:"rgba(99,102,241,0.06)",borderRadius:10,marginBottom:16,
              border:`1px solid ${C.blue}22`}}>
              <div style={{width:36,height:36,borderRadius:9,background:C.blue+"20",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontWeight:800,fontSize:16,color:C.blue,flexShrink:0}}>
                {branchTarget.user.name[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:600,fontSize:15}}>{branchTarget.user.name}</div>
                <div style={{fontSize:13,color:C.text3}}>{branchTarget.user.email}</div>
              </div>
            </div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:8}}>
              🏪 Assign to Branch
            </label>
            <Select
              value={branchTarget.branchId||""}
              onChange={e=>setBranchTarget(t=>({...t,branchId:e.target.value}))}
              style={{width:"100%"}}>
              <option value="">— No branch (floating / admin) —</option>
              {branches.map(b=>(
                <option key={b.id} value={b.id}>
                  {b.name}{b.location?` · ${b.location}`:""}
                  {b.isHQ?" (HQ)":""}
                </option>
              ))}
            </Select>
            <div style={{fontSize:12,color:C.text3,marginTop:6}}>
              Cashiers are locked to their assigned branch. Managers can switch freely.
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn variant="ghost" onClick={()=>setBranchTarget(null)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn onClick={handleBranchAssign} disabled={actionLoading} style={{flex:2,justifyContent:"center"}}>
              {actionLoading
                ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Saving…</span>
                :"💾 Save Assignment"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── OTP Admin Delete Modal ── */}
      {otpDeleteTarget&&(
        <Modal title="🔐 Delete Admin Account" onClose={()=>{setOtpDeleteTarget(null);setOtpInput("");setOtpSent(false);setOtpError("");setOtpDevCode(null);}}>
          <div style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
              background:"rgba(239,68,68,0.06)",borderRadius:10,marginBottom:16,
              border:`1px solid ${C.red}22`}}>
              <div style={{width:36,height:36,borderRadius:9,background:C.amber+"20",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontWeight:800,fontSize:16,color:C.amber,flexShrink:0}}>
                {otpDeleteTarget.name[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:600,fontSize:15}}>{otpDeleteTarget.name}</div>
                <div style={{fontSize:13,color:C.text3}}>{otpDeleteTarget.email} · Admin</div>
              </div>
            </div>

            {!otpSent?(
              <div>
                <div style={{fontSize:14,color:C.text2,marginBottom:12,lineHeight:1.5}}>
                  Deleting an admin account requires OTP verification. A 6-digit code will be sent to your <strong>email address</strong>.
                </div>
                {otpError&&<div style={{color:C.red,fontSize:13,marginBottom:8,padding:"8px 12px",background:"rgba(239,68,68,0.08)",borderRadius:8}}>{otpError}</div>}
                <Btn onClick={()=>handleRequestOtp(otpDeleteTarget)} disabled={otpLoading} style={{width:"100%",justifyContent:"center"}}>
                  {otpLoading
                    ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Sending…</span>
                    :"📧 Send OTP to My Email"}
                </Btn>
              </div>
            ):(
              <div>
                <div style={{fontSize:14,color:C.text2,marginBottom:12}}>
                  Enter the 6-digit code sent to your email to confirm deletion.
                </div>
                {otpDevCode&&(
                  <div style={{background:"rgba(245,158,11,0.1)",border:`1px solid ${C.amber}44`,borderRadius:8,padding:"8px 12px",marginBottom:10,fontSize:13,color:C.amber}}>
                    🔑 Dev mode — OTP: <strong>{otpDevCode}</strong>
                  </div>
                )}
                <Input
                  value={otpInput}
                  onChange={e=>setOtpInput(e.target.value)}
                  placeholder="Enter 6-digit OTP"
                  maxLength={6}
                  style={{letterSpacing:"0.3em",fontSize:20,textAlign:"center",marginBottom:8}}
                  autoFocus
                />
                {otpError&&<div style={{color:C.red,fontSize:13,marginBottom:8,padding:"8px 12px",background:"rgba(239,68,68,0.08)",borderRadius:8}}>{otpError}</div>}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  <Btn variant="ghost" onClick={()=>setOtpSent(false)} style={{flex:1,justifyContent:"center"}}>← Resend</Btn>
                  <Btn onClick={handleOtpDelete} disabled={otpLoading||otpInput.length<6}
                    style={{flex:2,justifyContent:"center",background:C.red,borderColor:C.red}}>
                    {otpLoading
                      ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #00000040",borderTopColor:"#000",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Deleting…</span>
                      :"🗑 Confirm Delete"}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════ ALL BRANCHES PANEL (admin read-only overview) ══════════ */
function AllBranchesPanel({onBranchesChanged}){
  const [branches, setBranches]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [addModal, setAddModal]     = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm]             = useState({name:"",location:"",phone:""});
  const [saving, setSaving]         = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [error, setError]           = useState("");
  const [toast, setToast]           = useState(null);
  const [settingHQ, setSettingHQ]   = useState(null); // id being set as HQ

  const load = () => {
    setLoading(true);
    apiFetch("/api/branches").then(r=>r.json())
      .then(d=>setBranches(Array.isArray(d)?d:[]))
      .catch(()=>{})
      .finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);

  const showToast = (type, msg) => { setToast({type,msg}); setTimeout(()=>setToast(null),3000); };

  const openAdd = () => {
    setForm({name:"",location:"",phone:""});
    setError(""); setEditTarget(null); setAddModal(true);
  };

  const openEdit = (b) => {
    setForm({name:b.name,location:b.location||"",phone:b.phone||""});
    setError(""); setEditTarget(b); setAddModal(true);
  };

  const handleSave = async () => {
    if(!form.name.trim()){setError("Branch name is required.");return;}
    setSaving(true); setError("");
    try{
      const url    = editTarget ? `/api/branches/${editTarget.id}` : "/api/branches";
      const method = editTarget ? "PATCH" : "POST";
      const r = await apiFetch(url,{method,body:JSON.stringify(form)});
      const d = await r.json();
      if(!r.ok){setError(d.error||"Failed.");setSaving(false);return;}
      setAddModal(false);
      showToast("ok", editTarget ? "Branch updated." : "Branch added.");
      load(); if(onBranchesChanged) onBranchesChanged();
    }catch{setError(getOfflineError("Cannot connect to server."));}
    setSaving(false);
  };

  const handleSetHQ = async (b) => {
    if(b.isHQ) return; // already HQ
    setSettingHQ(b.id);
    try{
      const r = await apiFetch(`/api/branches/${b.id}`,{method:"PATCH",body:JSON.stringify({isHQ:true})});
      if(r.ok){ showToast("ok",`${b.name} is now the Headquarters.`); load(); if(onBranchesChanged) onBranchesChanged(); }
      else { const d=await r.json(); showToast("err",d.error||"Failed."); }
    }catch{ showToast("err","Cannot connect."); }
    setSettingHQ(null);
  };

  const handleDelete = async (b) => {
    try{
      const r = await apiFetch(`/api/branches/${b.id}`,{method:"DELETE"});
      const d = await r.json();
      if(r.ok){ showToast("ok","Branch removed."); setDeleteConfirm(null); load(); if(onBranchesChanged) onBranchesChanged(); }
      else showToast("err", d.error||"Failed.");
    }catch{ showToast("err","Cannot connect."); }
  };

  return(
    <Card style={{padding:20,marginBottom:16}}>
      {toast&&(
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:4000,
          padding:"10px 18px",borderRadius:10,fontSize:14,fontWeight:600,
          background:toast.type==="ok"?`${C.green}18`:`${C.red}18`,
          border:`1px solid ${toast.type==="ok"?C.green:C.red}44`,
          color:toast.type==="ok"?C.green:C.red,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
          {toast.type==="ok"?"✅":"⚠️"} {toast.msg}
        </div>
      )}

      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:36,height:36,borderRadius:10,background:"rgba(167,139,250,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🗺️</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:16,color:C.purple}}>All Branches</div>
          <div style={{fontSize:13,color:C.text3,marginTop:1}}>Same name, different locations allowed</div>
        </div>
        <Btn onClick={openAdd} style={{fontSize:13,padding:"6px 14px"}}>+ Add Branch</Btn>
      </div>

      {loading&&<div style={{textAlign:"center",padding:16}}><span style={{width:18,height:18,border:`3px solid ${C.border}`,borderTopColor:C.purple,borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/></div>}

      {!loading&&branches.length===0&&(
        <div style={{textAlign:"center",padding:"20px 0",color:C.text3,fontSize:14}}>
          No branches yet. Click <strong>+ Add Branch</strong> to create your first location.
        </div>
      )}

      {!loading&&branches.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {branches.map(b=>(
            <div key={b.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
              borderRadius:10,
              background:b.isHQ?"rgba(245,158,11,0.05)":"rgba(255,255,255,0.02)",
              border:`1px solid ${b.isHQ?C.amber+"44":C.border}`}}>
              <div style={{width:32,height:32,borderRadius:8,
                background:b.isHQ?C.amberGlow:C.purple+"18",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
                {b.isHQ?"🏆":"🏪"}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:16,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  {b.name}
                  {b.isHQ&&<span style={{fontSize:11,fontWeight:700,color:C.amber,background:C.amberGlow,padding:"1px 8px",borderRadius:20}}>HQ</span>}
                </div>
                <div style={{fontSize:13,color:C.text3,marginTop:1}}>
                  {[b.location,b.phone].filter(Boolean).join(" · ")||<span style={{fontStyle:"italic"}}>No details added</span>}
                </div>
              </div>
              <div style={{display:"flex",gap:5,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
                {!b.isHQ&&(
                  <button onClick={()=>handleSetHQ(b)} disabled={settingHQ===b.id}
                    title="Set as Headquarters"
                    style={{padding:"4px 10px",borderRadius:7,border:`1px solid ${C.amber}55`,
                      background:"transparent",color:C.amber,cursor:"pointer",fontSize:12,fontWeight:600,
                      opacity:settingHQ===b.id?0.6:1,transition:"all 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.amberGlow}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    {settingHQ===b.id?"…":"🏆 Set HQ"}
                  </button>
                )}
                <button onClick={()=>openEdit(b)}
                  style={{padding:"4px 10px",borderRadius:7,border:`1px solid ${C.border}`,
                    background:"transparent",color:C.text2,cursor:"pointer",fontSize:12,fontWeight:600,
                    transition:"all 0.15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.blue;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text2;}}>
                  ✏️ Edit
                </button>
                <button onClick={()=>setDeleteConfirm(b)} disabled={b.isHQ}
                  title={b.isHQ?"Cannot delete the Headquarters — set another branch as HQ first":"Remove branch"}
                  style={{padding:"4px 10px",borderRadius:7,border:`1px solid ${b.isHQ?C.border:C.red+"44"}`,
                    background:"transparent",color:b.isHQ?C.text3:C.red,
                    cursor:b.isHQ?"not-allowed":"pointer",fontSize:12,fontWeight:600,
                    opacity:b.isHQ?0.4:1,transition:"all 0.15s"}}
                  onMouseEnter={e=>{if(!b.isHQ)e.currentTarget.style.background=C.redGlow;}}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit modal */}
      {addModal&&(
        <Modal title={editTarget?"Edit Branch":"Add New Branch"} onClose={()=>setAddModal(false)}>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div>
              <label style={{fontSize:14,color:C.text2,fontWeight:600,display:"block",marginBottom:5}}>Branch Name *</label>
              <Input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                placeholder="e.g. StarMart" autoFocus/>
            </div>
            <div>
              <label style={{fontSize:14,color:C.text2,fontWeight:600,display:"block",marginBottom:5}}>
                Location / Address
                <span style={{fontSize:12,color:C.text3,fontWeight:400,marginLeft:6}}>— distinguishes branches with the same name</span>
              </label>
              <Input value={form.location} onChange={e=>setForm(f=>({...f,location:e.target.value}))}
                placeholder="e.g. Westlands Mall, Ground Floor"/>
            </div>
            <div>
              <label style={{fontSize:14,color:C.text2,fontWeight:600,display:"block",marginBottom:5}}>Phone Number</label>
              <Input value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))}
                placeholder="e.g. +254 700 000 000"/>
            </div>
            {error&&<div style={{background:C.redGlow,border:`1px solid ${C.red}44`,borderRadius:8,padding:"9px 12px",fontSize:14,color:C.red}}>⚠️ {error}</div>}
            <div style={{padding:"8px 12px",borderRadius:8,background:"rgba(99,102,241,0.06)",border:`1px solid ${C.blue}22`,fontSize:12,color:C.text3}}>
              💡 Two branches can share the same name (e.g. "StarMart") as long as they have different locations.
            </div>
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <Btn variant="ghost" onClick={()=>setAddModal(false)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
              <Btn onClick={handleSave} disabled={saving} style={{flex:2,justifyContent:"center"}}>
                {saving?"Saving…":editTarget?"💾 Save Changes":"➕ Add Branch"}
              </Btn>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteConfirm&&(
        <Modal title="Remove Branch" onClose={()=>setDeleteConfirm(null)}>
          <div style={{textAlign:"center",padding:"8px 0 16px"}}>
            <div style={{fontSize:40,marginBottom:12}}>🏪</div>
            <div style={{fontWeight:700,fontSize:17,marginBottom:4}}>{deleteConfirm.name}</div>
            {deleteConfirm.location&&<div style={{fontSize:14,color:C.text3,marginBottom:12}}>{deleteConfirm.location}</div>}
            <div style={{color:C.text3,fontSize:14,lineHeight:1.6,marginBottom:20}}>
              This will deactivate the branch. All existing orders and stock data are preserved.
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn variant="ghost" onClick={()=>setDeleteConfirm(null)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
              <Btn variant="danger" onClick={()=>handleDelete(deleteConfirm)} style={{flex:1,justifyContent:"center"}}>🗑️ Remove</Btn>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/* ══════════ SETTINGS VIEW ══════════ */
function SettingsView({currentUser,fetchProducts,fetchPendingTransfers,setPendingTransfers,fetchBranches,onSettingsSaved}){
  const perms = currentUser?.perms || {};
  const [shopForm, setShopForm] = useState(getShopSettings());
  const [shopSaved, setShopSaved] = useState(false);
  const setShop = (k,v) => setShopForm(f=>({...f,[k]:v}));

  // On mount: if admin has settings in localStorage that aren't in DB yet,
  // push them automatically so all roles get the live config
  useEffect(()=>{
    if(currentUser?.role !== "admin") return;
    const local = getShopSettings();
    const hasLocal = local.paybill || local.till || local.name !== "My Shop";
    if(!hasLocal) return;
    // Check DB and push if empty or outdated
    apiFetch("/api/settings").then(async r=>{
      if(!r.ok) return;
      const db = await r.json();
      const dbEmpty = !db || Object.keys(db).length === 0 || (!db.paybill && !db.till);
      if(dbEmpty){
        // DB has no settings — push local ones now silently
        await apiFetch("/api/settings",{method:"PUT",body:JSON.stringify(local)}).catch(()=>{});
        if(onSettingsSaved) onSettingsSaved(local);
      }
    }).catch(()=>{});
  },[]);  // eslint-disable-line react-hooks/exhaustive-deps


  const handleShopSave = async () => {
    saveShopSettings(shopForm); // save to localStorage immediately for instant effect
    setShopSaved(true);
    if(onSettingsSaved) onSettingsSaved(shopForm); // update App-level state so POSView gets live values
    try {
      await apiFetch("/api/settings", { method:"PUT", body:JSON.stringify(shopForm) });
    } catch(e) {
      console.warn("Could not save settings to server:", e.message);
    }
    setTimeout(()=>setShopSaved(false), 2500);
  };


  const shopFields = [
    {key:"name",     label:"Shop Name",           placeholder:"e.g. StarMart",                icon:"🏪"},
    {key:"address",  label:"Receipt Address",      placeholder:"e.g. Westlands, Nairobi",      icon:"📍"},
    {key:"phone",    label:"Business Phone",       placeholder:"e.g. +254 700 000 000",        icon:"📞"},
    {key:"email",    label:"Email",                placeholder:"e.g. info@starmart.co.ke",     icon:"✉️"},
    {key:"thankYou", label:"Receipt Message",      placeholder:"Thank you for shopping! 🇰🇪",  icon:"🙏"},
  ];

  // Low stock threshold setting (rendered separately as a number input)
  const lowStockVal = parseInt(shopForm.lowStockThreshold)||5;

  const mpesaFields = [
    {key:"paybill",        label:"Paybill No.",        placeholder:"e.g. 247247", icon:"🏦"},
    {key:"paybillAccount", label:"Paybill Account",    placeholder:"e.g. POS",   icon:"🔢"},
    {key:"till",           label:"Buy Goods Till No.", placeholder:"e.g. 123456", icon:"🏪"},
    {key:"pochiPhone",     label:"Pochi la Biashara",  placeholder:"e.g. 0712 345 678", icon:"👜"},
  ];

  return(
    <div style={{padding:"14px 12px",overflowY:"auto",height:"100%",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch"}}>



      {/* ── Shop / Receipt Settings ────────────────────────────────────────── */}
      <Card style={{padding:20,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(245,158,11,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🧾</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:C.amber}}>Receipt & Shop Details</div>
            <div style={{fontSize:13,color:C.text3,marginTop:1}}>Appears on printed receipts for customers</div>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {shopFields.map(f=>(
            <div key={f.key}>
              <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:5}}>{f.icon} {f.label}</label>
              {f.key==="thankYou"
                ?<textarea value={shopForm[f.key]} onChange={e=>setShop(f.key,e.target.value)} placeholder={f.placeholder} rows={2}
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card,color:C.text,fontSize:14,resize:"vertical",outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
                :<Input value={shopForm[f.key]} onChange={e=>setShop(f.key,e.target.value)} placeholder={f.placeholder}/>
              }
            </div>
          ))}
          <Btn onClick={handleShopSave} style={{alignSelf:"flex-start"}}>
            {shopSaved?"✅ Saved!":"💾 Save Receipt Settings"}
          </Btn>
        </div>
      </Card>

      {/* ── Low Stock Threshold ───────────────────────────────────────────── */}
      <Card style={{padding:20,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(245,158,11,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⚠️</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:C.amber}}>Low Stock Alert</div>
            <div style={{fontSize:13,color:C.text3,marginTop:1}}>Items below this quantity are flagged as low stock</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:200}}>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:6}}>⚠️ Low Stock Threshold (units)</label>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button onClick={()=>setShop("lowStockThreshold",Math.max(1,lowStockVal-1))}
                style={{width:36,height:36,borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:20,fontWeight:600}}>−</button>
              <input
                type="number" min="1" max="999"
                value={shopForm.lowStockThreshold??5}
                onChange={e=>setShop("lowStockThreshold",Math.max(1,parseInt(e.target.value)||1))}
                style={{width:80,background:"#0D1117",border:`1px solid ${C.amber}55`,color:C.amber,
                  borderRadius:8,padding:"9px 12px",fontSize:20,fontFamily:"DM Mono,monospace",
                  textAlign:"center",outline:"none",fontWeight:700}}
              />
              <button onClick={()=>setShop("lowStockThreshold",lowStockVal+1)}
                style={{width:36,height:36,borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.text,cursor:"pointer",fontSize:20,fontWeight:600}}>+</button>
            </div>
          </div>
          <div style={{flex:2,minWidth:220}}>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:4}}>
              {[5,10,15,20,50].map(v=>(
                <button key={v} onClick={()=>setShop("lowStockThreshold",v)}
                  style={{padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600,
                    border:`1px solid ${lowStockVal===v?C.amber:C.border}`,
                    background:lowStockVal===v?"rgba(245,158,11,0.12)":"transparent",
                    color:lowStockVal===v?C.amber:C.text2,transition:"all 0.15s"}}>
                  {v} units
                </button>
              ))}
            </div>
            <div style={{fontSize:13,color:C.text3,marginTop:8,lineHeight:1.5}}>
              Products with fewer than <strong style={{color:C.amber}}>{lowStockVal} unit{lowStockVal!==1?"s":""}</strong> will be highlighted red on the POS,
              flagged in inventory, and included in the reorder export.
            </div>
          </div>
        </div>
        <div style={{marginTop:14}}>
          <Btn onClick={handleShopSave} style={{alignSelf:"flex-start"}}>
            {shopSaved?"✅ Saved!":"💾 Save Threshold"}
          </Btn>
        </div>
      </Card>

      {/* ── M-Pesa Settings ────────────────────────────────────────────────── */}
      <Card style={{padding:20,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(34,197,94,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📱</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:C.green}}>M-Pesa Settings</div>
            <div style={{fontSize:13,color:C.text3,marginTop:1}}>Configure payment channels for this branch</div>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {mpesaFields.map(f=>(
            <div key={f.key}>
              <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:5}}>{f.icon} {f.label}</label>
              <Input value={shopForm[f.key]||""} onChange={e=>setShop(f.key,e.target.value)} placeholder={f.placeholder}/>
            </div>
          ))}
          <Btn onClick={handleShopSave} style={{alignSelf:"flex-start"}}>
            {shopSaved?"✅ Saved!":"💾 Save M-Pesa Settings"}
          </Btn>
        </div>
      </Card>

      {/* ── Security / 2FA — admin only ───────────────────────────────────── */}
      {perms.badge==="ADMIN"&&<SecuritySettings currentUser={currentUser}/>}

      {/* ── Staff Management (admin only) ─────────────────────────────────── */}
      {perms.badge==="ADMIN"&&(
        <StaffManagement currentUser={currentUser}/>
      )}

      {/* ── All Branches (admin only — read only overview) ─────────────────── */}
      {perms.badge==="ADMIN"&&(
        <AllBranchesPanel onBranchesChanged={fetchBranches}/>
      )}

      {/* ── Transfer Approval Queue (admin only) ──────────────────────────── */}
      <TransferApprovalQueue currentUser={currentUser}/>
    </div>
  );
}


/* ── Security / 2FA settings card ─────────────────────────────────────────── */
function SecuritySettings({currentUser}){
  const [myPhone,  setMyPhone]  = useState("");
  const [twoFaOn,  setTwoFaOn]  = useState(false);
  const [status,   setStatus]   = useState(""); // loading message
  const [info,     setInfo]     = useState(null); // { type:"ok"|"err", msg }

  // Step tracking: "idle" | "sendingSetup" | "enterCode" | "disabling"
  const [step,     setStep]     = useState("idle");
  const [setupCode,setSetupCode]= useState("");
  const [disablePass,setDisablePass]=useState("");
  const [masked,   setMasked]   = useState("");

  useEffect(()=>{
    apiFetch("/api/auth/me").then(r=>r.json()).then(d=>{
      if(d.user){ setMyPhone(d.user.phone||""); setTwoFaOn(d.user.twoFaEnabled||false); }
    }).catch(()=>{});
  },[]);

  const ok  = (msg) => setInfo({type:"ok",  msg});
  const err = (msg) => setInfo({type:"err", msg});

  const savePhone = async () => {
    if(!myPhone.trim()) return err("Enter a phone number.");
    setStatus("Saving…"); setInfo(null);
    const res = await apiFetch("/api/auth/update-phone",{method:"POST",body:JSON.stringify({phone:myPhone})});
    const d   = await res.json();
    setStatus("");
    res.ok ? ok("Phone number saved.") : err(d.error||"Failed.");
  };

  const startSetup2FA = async () => {
    setStatus("Sending email…"); setInfo(null);
    const res = await apiFetch("/api/auth/setup-2fa",{method:"POST"});
    const d   = await res.json();
    setStatus("");
    if(!res.ok){ err(d.error||"Failed."); return; }
    setMasked(d.maskedEmail||(d.devCode?"DEV MODE":""));
    if(d.devCode) setSetupCode(d.devCode); // auto-fill in dev mode
    setStep("enterCode");
  };

  const confirmSetup2FA = async () => {
    if(setupCode.length!==6) return err("Enter the 6-digit code.");
    setStatus("Verifying…"); setInfo(null);
    const res = await apiFetch("/api/auth/confirm-2fa",{method:"POST",body:JSON.stringify({code:setupCode})});
    const d   = await res.json();
    setStatus("");
    if(!res.ok){ err(d.error||"Incorrect code."); return; }
    setTwoFaOn(true); setStep("idle"); setSetupCode(""); ok("✅ Two-factor authentication is now enabled.");
  };

  const disable2FA = async () => {
    if(!disablePass) return err("Enter your password.");
    setStatus("Disabling…"); setInfo(null);
    const res = await apiFetch("/api/auth/disable-2fa",{method:"POST",body:JSON.stringify({password:disablePass})});
    const d   = await res.json();
    setStatus("");
    if(!res.ok){ err(d.error||"Incorrect password."); return; }
    setTwoFaOn(false); setStep("idle"); setDisablePass(""); ok("2FA disabled.");
  };

  return(
    <div style={{marginTop:24}}>
      <Card style={{padding:24,maxWidth:560}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(99,102,241,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🔐</div>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>Account Security</div>
            <div style={{fontSize:15,color:C.text3}}>Two-factor authentication via email</div>
          </div>
          {twoFaOn&&<div style={{marginLeft:"auto",fontSize:13,fontWeight:600,padding:"3px 10px",borderRadius:20,background:`${C.green}15`,color:C.green,border:`1px solid ${C.green}33`}}>2FA ON</div>}
        </div>

        {/* 2FA section */}
        <div style={{marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:15,marginBottom:4}}>Two-Factor Authentication (2FA)</div>
          <div style={{fontSize:14,color:C.text3,lineHeight:1.6}}>
            When enabled, a 6-digit code will be sent to your <strong>email address</strong> every time you log in.
          </div>
        </div>

        {!twoFaOn&&step==="idle"&&(
          <Btn onClick={startSetup2FA} style={{width:"100%",justifyContent:"center"}} disabled={!!status}>
            {status==="Sending email…"?"Sending email…":"📧 Enable Two-Factor Authentication"}
          </Btn>
        )}

        {!twoFaOn&&step==="enterCode"&&(
          <div style={{background:"rgba(99,102,241,0.06)",border:`1px solid ${C.blue}30`,borderRadius:10,padding:16}}>
            <div style={{fontSize:14,color:"#818CF8",fontWeight:600,marginBottom:4}}>📧 Code sent to {masked}</div>
            <div style={{fontSize:15,color:C.text3,marginBottom:12}}>Enter the 6-digit code from your email to activate 2FA.</div>
            <Input value={setupCode} onChange={e=>setSetupCode(e.target.value.replace(/\D/g,"").slice(0,6))}
              placeholder="_ _ _ _ _ _" autoFocus
              style={{fontFamily:"'DM Mono',monospace",fontSize:24,letterSpacing:"0.3em",textAlign:"center",marginBottom:10}}
              onKeyDown={e=>e.key==="Enter"&&confirmSetup2FA()}/>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={confirmSetup2FA} style={{flex:1,justifyContent:"center"}} disabled={!!status}>
                {status||"Activate 2FA"}
              </Btn>
              <Btn onClick={startSetup2FA} variant="ghost" style={{padding:"0 14px"}} disabled={!!status} title="Resend email">↺</Btn>
              <Btn onClick={()=>{setStep("idle");setSetupCode("");}} variant="ghost" style={{padding:"0 14px"}}>Cancel</Btn>
            </div>
          </div>
        )}

        {twoFaOn&&step==="idle"&&(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,background:`${C.green}0D`,border:`1px solid ${C.green}33`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
              <span style={{fontSize:20}}>✅</span>
              <div style={{fontSize:15,color:C.green,fontWeight:500}}>Two-factor authentication is active</div>
            </div>
            <Btn onClick={()=>setStep("disabling")} variant="danger" style={{width:"100%",justifyContent:"center"}}>
              Disable 2FA
            </Btn>
          </div>
        )}

        {twoFaOn&&step==="disabling"&&(
          <div style={{background:`${C.red}0D`,border:`1px solid ${C.red}33`,borderRadius:10,padding:16}}>
            <div style={{fontSize:15,fontWeight:600,color:C.red,marginBottom:8}}>Disable Two-Factor Authentication</div>
            <div style={{fontSize:14,color:C.text3,marginBottom:12}}>Enter your current password to confirm.</div>
            <Input type="password" value={disablePass} onChange={e=>setDisablePass(e.target.value)}
              placeholder="Current password" style={{marginBottom:10}}
              onKeyDown={e=>e.key==="Enter"&&disable2FA()}/>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={disable2FA} variant="danger" style={{flex:1,justifyContent:"center"}} disabled={!!status}>
                {status||"Confirm Disable"}
              </Btn>
              <Btn onClick={()=>{setStep("idle");setDisablePass("");}} variant="ghost" style={{padding:"0 14px"}}>Cancel</Btn>
            </div>
          </div>
        )}

        {info&&<div style={{marginTop:12,background:info.type==="ok"?`${C.green}15`:`${C.red}15`,border:`1px solid ${info.type==="ok"?C.green:C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:info.type==="ok"?C.green:C.red}}>{info.msg}</div>}
      </Card>
    </div>
  );
}

/* ══════════ PROFILE MODAL ══════════ */
function ProfileModal({user, onClose, onUpdated}){
  const [tab, setTab]         = useState("view"); // "view" | "edit" | "password"
  const [form, setForm]       = useState({name:user.name||"", email:user.email||"", phone:user.phone||""});
  const [pwForm, setPwForm]   = useState({current:"", newPw:"", confirm:""});
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState("");

  const set  = (k,v) => setForm(f=>({...f,[k]:v}));
  const setPw= (k,v) => setPwForm(f=>({...f,[k]:v}));

  // Password strength
  const pwScore = [pwForm.newPw.length>=8, /[A-Z]/.test(pwForm.newPw), /[0-9]/.test(pwForm.newPw), /[^a-zA-Z0-9]/.test(pwForm.newPw)].filter(Boolean).length;
  const pwColors = ["#ef4444","#f97316","#eab308","#22c55e"];
  const pwLabels = ["Weak","Fair","Good","Strong"];

  const handleSaveProfile = async () => {
    if(!form.name.trim()) return setError("Name is required.");
    if(!form.email.includes("@")) return setError("Enter a valid email.");
    setSaving(true); setError(""); setSuccess("");
    try{
      const r = await apiFetch("/api/auth/profile", {method:"PATCH", body:JSON.stringify({name:form.name.trim(), email:form.email.trim(), phone:form.phone.trim()||null})});
      const d = await r.json();
      if(!r.ok){ setError(d.error||"Failed to save."); }
      else{ setSuccess("Profile updated successfully!"); onUpdated({name:d.user.name, email:d.user.email, phone:d.user.phone}); }
    }catch{setError(getOfflineError("Cannot connect to server.")); }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    if(!pwForm.current) return setError("Enter your current password.");
    if(pwForm.newPw.length<8) return setError("New password must be at least 8 characters.");
    if(pwForm.newPw !== pwForm.confirm) return setError("New passwords do not match.");
    setSaving(true); setError(""); setSuccess("");
    try{
      const r = await apiFetch("/api/auth/change-password", {method:"POST", body:JSON.stringify({currentPassword:pwForm.current, newPassword:pwForm.newPw})});
      const d = await r.json();
      if(!r.ok){ setError(d.error||"Failed to change password."); }
      else{ setSuccess("Password changed successfully!"); setPwForm({current:"", newPw:"", confirm:""}); }
    }catch{setError(getOfflineError("Cannot connect to server.")); }
    setSaving(false);
  };

  const rc = {admin:"#f5a623", manager:"#a855f7", cashier:"#3b82f6"}[user.role] || C.blue;

  return(
    <Modal title="My Profile" onClose={onClose}>
      {/* Profile header */}
      <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",
        borderRadius:12,background:`linear-gradient(135deg,${rc}12,${rc}04)`,
        border:`1px solid ${rc}33`,marginBottom:16}}>
        <div style={{width:56,height:56,borderRadius:16,background:rc,
          display:"flex",alignItems:"center",justifyContent:"center",
          fontWeight:800,fontSize:24,color:"#000",flexShrink:0}}>
          {user.name[0].toUpperCase()}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:800,fontSize:18,letterSpacing:"-0.02em"}}>{user.name}</div>
          <div style={{fontSize:13,color:C.text3,marginTop:2}}>{user.email}</div>
          <div style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:4,
            padding:"2px 10px",borderRadius:20,background:rc+"18",
            border:`1px solid ${rc}33`,fontSize:12,fontWeight:700,color:rc,
            textTransform:"uppercase",letterSpacing:"0.06em"}}>
            {user.role==="admin"?"⚙️":user.role==="manager"?"📊":"🏪"} {user.role}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,background:C.card,borderRadius:9,padding:4,marginBottom:18}}>
        {[["view","👤 View"],["edit","✏️ Edit Info"],["password","🔒 Password"]].map(([id,label])=>(
          <button key={id} onClick={()=>{setTab(id);setError("");setSuccess("");}}
            style={{flex:1,padding:"8px 4px",borderRadius:6,border:"none",cursor:"pointer",
              fontSize:13,fontWeight:600,transition:"all 0.15s",
              background:tab===id?"rgba(99,102,241,0.18)":"transparent",
              color:tab===id?C.blue:C.text3}}>
            {label}
          </button>
        ))}
      </div>

      {/* ── VIEW tab ── */}
      {tab==="view"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[
            {icon:"👤", label:"Full Name",   value:user.name},
            {icon:"✉️", label:"Email",       value:user.email},
            {icon:"📞", label:"Phone",       value:user.phone||"—"},
            {icon:"🎭", label:"Role",        value:user.role.charAt(0).toUpperCase()+user.role.slice(1)},
          ].map(row=>(
            <div key={row.label} style={{display:"flex",alignItems:"center",gap:12,
              padding:"10px 14px",borderRadius:10,background:"rgba(255,255,255,0.02)",
              border:`1px solid ${C.border}`}}>
              <span style={{fontSize:18,flexShrink:0}}>{row.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:C.text3,fontWeight:500,letterSpacing:"0.04em",
                  textTransform:"uppercase",marginBottom:2}}>{row.label}</div>
                <div style={{fontSize:15,fontWeight:500,color:C.text,
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.value}</div>
              </div>
            </div>
          ))}
          <Btn onClick={()=>setTab("edit")} style={{width:"100%",justifyContent:"center",marginTop:4}}>
            ✏️ Edit My Profile
          </Btn>
        </div>
      )}

      {/* ── EDIT tab ── */}
      {tab==="edit"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>👤 Full Name *</label>
            <Input value={form.name} onChange={e=>set("name",e.target.value)} placeholder="Your full name"/>
          </div>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>✉️ Email *</label>
            <Input type="email" value={form.email} onChange={e=>set("email",e.target.value)} placeholder="you@starmart.co.ke"/>
          </div>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>📞 Phone <span style={{color:C.text3,fontWeight:400,fontSize:11}}>(for 2FA & password reset)</span></label>
            <Input value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="e.g. 0712 345 678" style={{fontFamily:"'DM Mono',monospace"}}/>
          </div>
          {error&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:14,color:C.red}}>⚠️ {error}</div>}
          {success&&<div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:8,padding:"10px 14px",fontSize:14,color:C.green}}>✅ {success}</div>}
          <div style={{display:"flex",gap:8}}>
            <Btn variant="ghost" onClick={()=>setTab("view")} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn onClick={handleSaveProfile} disabled={saving} style={{flex:2,justifyContent:"center"}}>
              {saving?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Saving…</span>:"💾 Save Changes"}
            </Btn>
          </div>
        </div>
      )}

      {/* ── PASSWORD tab ── */}
      {tab==="password"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>Current Password</label>
            <div style={{position:"relative"}}>
              <Input type={showCur?"text":"password"} value={pwForm.current}
                onChange={e=>setPw("current",e.target.value)}
                placeholder="Enter your current password" style={{paddingRight:40}}/>
              <button onClick={()=>setShowCur(s=>!s)} style={{position:"absolute",right:12,top:"50%",
                transform:"translateY(-50%)",background:"none",border:"none",
                color:showCur?C.amber:C.text3,cursor:"pointer",fontSize:15,padding:0}}>
                {showCur?"🙈":"👁️"}
              </button>
            </div>
          </div>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>New Password</label>
            <div style={{position:"relative"}}>
              <Input type={showNew?"text":"password"} value={pwForm.newPw}
                onChange={e=>setPw("newPw",e.target.value)}
                placeholder="Min. 8 characters" style={{paddingRight:40}}/>
              <button onClick={()=>setShowNew(s=>!s)} style={{position:"absolute",right:12,top:"50%",
                transform:"translateY(-50%)",background:"none",border:"none",
                color:showNew?C.amber:C.text3,cursor:"pointer",fontSize:15,padding:0}}>
                {showNew?"🙈":"👁️"}
              </button>
            </div>
            {/* Password strength bar */}
            {pwForm.newPw&&(
              <div style={{marginTop:6}}>
                <div style={{display:"flex",gap:3,marginBottom:3}}>
                  {[0,1,2,3].map(i=><div key={i} style={{flex:1,height:3,borderRadius:2,
                    background:i<pwScore?pwColors[pwScore-1]:"#1F2937",transition:"all 0.3s"}}/>)}
                </div>
                <div style={{fontSize:12,fontWeight:600,color:pwScore>0?pwColors[pwScore-1]:C.text3}}>
                  {pwScore>0?pwLabels[pwScore-1]:""}
                </div>
              </div>
            )}
          </div>
          <div>
            <label style={{fontSize:13,color:C.text2,fontWeight:600,letterSpacing:"0.04em",
              textTransform:"uppercase",display:"block",marginBottom:6}}>Confirm New Password</label>
            <Input type="password" value={pwForm.confirm}
              onChange={e=>setPw("confirm",e.target.value)}
              placeholder="Re-enter new password"/>
            {pwForm.confirm&&<div style={{marginTop:5,fontSize:13,fontWeight:600,
              color:pwForm.confirm===pwForm.newPw?C.green:C.red}}>
              {pwForm.confirm===pwForm.newPw?"✓ Passwords match":"✗ Passwords don't match"}
            </div>}
          </div>
          {error&&<div style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:14,color:C.red}}>⚠️ {error}</div>}
          {success&&<div style={{background:C.green+"15",border:`1px solid ${C.green}44`,borderRadius:8,padding:"10px 14px",fontSize:14,color:C.green}}>✅ {success}</div>}
          <div style={{display:"flex",gap:8}}>
            <Btn variant="ghost" onClick={()=>{setTab("view");setPwForm({current:"",newPw:"",confirm:""});setError("");setSuccess("");}} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
            <Btn onClick={handleChangePassword} disabled={saving||pwForm.newPw!==pwForm.confirm||pwForm.newPw.length<8}
              style={{flex:2,justifyContent:"center",
                opacity:saving||pwForm.newPw!==pwForm.confirm||pwForm.newPw.length<8?0.5:1}}>
              {saving?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Changing…</span>:"🔒 Change Password"}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ══════════ SWITCH USER MODAL ══════════ */
function SwitchUserModal({onSwitch,onClose}){
  const [email,setEmail]=useState("");
  const [pass,setPass]=useState("");
  const [showPass,setShowPass]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [shakeKey,setShakeKey]=useState(0);

  const handleSwitch=async()=>{
    if(!email.includes("@")) return setError("Enter a valid email.");
    if(pass.length<4)        return setError("Password too short.");
    setLoading(true);setError("");
    try{
      const res=await fetch(`${API_URL}/api/auth/login`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email,password:pass}),
      });
      const data=await res.json();
      if(!res.ok){setError(data.error||"Invalid credentials.");setShakeKey(k=>k+1);setLoading(false);return;}
      if(data.requires2FA){setError("This account has 2FA enabled — sign in from the main login screen.");setLoading(false);return;}
      localStorage.setItem("starmart_token",data.token);
      onSwitch({...data.user,perms:PERMISSIONS[data.user.role]});
    }catch{setError(getOfflineError("Cannot connect to server."));}
    setLoading(false);
  };

  return(
    <Modal title="Switch User" onClose={onClose}>
      <div style={{marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
          background:"rgba(99,102,241,0.07)",border:`1px solid ${C.blue}25`,borderRadius:10,marginBottom:16}}>
          <span style={{fontSize:22}}>🔄</span>
          <div style={{fontSize:15,color:C.text2,lineHeight:1.6}}>
            Sign in as a different user without losing the current cart or session data.
          </div>
        </div>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Email</label>
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:16}}>✉️</span>
            <Input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&handleSwitch()}
              placeholder="staff@starmart.co.ke" autoFocus style={{paddingLeft:38}}/>
          </div>
        </div>
        <div style={{marginBottom:8}}>
          <label style={{fontSize:13,color:C.text2,fontWeight:500,letterSpacing:"0.04em",textTransform:"uppercase",display:"block",marginBottom:6}}>Password</label>
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:16}}>🔒</span>
            <Input type={showPass?"text":"password"} value={pass} onChange={e=>setPass(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&handleSwitch()}
              placeholder="Password" style={{paddingLeft:38,paddingRight:40}}/>
            <button onClick={()=>setShowPass(s=>!s)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:showPass?C.amber:C.text3,cursor:"pointer",fontSize:15,padding:0}}>
              {showPass?"🙈":"👁️"}
            </button>
          </div>
        </div>
      </div>
      {error&&<div key={shakeKey} className="shake" style={{background:C.red+"15",border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",fontSize:15,color:C.red,marginBottom:14}}>⚠️ {error}</div>}
      <div style={{display:"flex",gap:8}}>
        <Btn variant="ghost" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
        <Btn onClick={handleSwitch} disabled={loading} style={{flex:2,justifyContent:"center"}}>
          {loading
            ?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:13,height:13,border:"2px solid #ffffff40",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Switching…</span>
            :"🔄 Switch User"}
        </Btn>
      </div>
    </Modal>
  );
}

/* ══════════ ROOT APP ══════════ */
export default function App(){
  const {isMobile}=useResponsive();
  const [showCreateModal,setShowCreateModal]=useState(false);
  const [showSwitchModal,setShowSwitchModal]=useState(false);
  const [showProfileModal,setShowProfileModal]=useState(false);
  const [invScanOpen,setInvScanOpen]=useState(false); // inventory receive stock modal
  const [receiveStockOpen,setReceiveStockOpen]=useState(false);
  const [user,setUser]=useState(null);
  const [pendingCount,setPendingCount]=useState(0); // pending staff approvals
  const [view,setView]=useState("pos");
  const online=useOnlineStatus();
  const [products,setProducts]=useState([]);
  const [productsLoading,setProductsLoading]=useState(false);
  const [userMenuOpen,setUserMenuOpen]=useState(false);
  // Cart state lives here so it survives tab switches
  const [cart,setCart]=useState(()=>{
    try{
      const saved=localStorage.getItem("starmart_cart");
      return saved?JSON.parse(saved):[];
    }catch{ return []; }
  });
  const [delivery,setDelivery]=useState(()=>{
    const EMPTY={isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""};
    try{
      const saved=localStorage.getItem("starmart_delivery");
      if(!saved) return EMPTY;
      const parsed=JSON.parse(saved);
      // Only restore if delivery was actually active — never carry over fee to next sale
      return parsed?.isDelivery===true ? parsed : EMPTY;
    }catch{ return EMPTY; }
  });
  const [selCust,setSelCust]=useState(()=>{
    try{
      const saved=localStorage.getItem("starmart_pos_customer");
      return saved?JSON.parse(saved):null;
    }catch{ return null; }
  });
  const [discountValue,setDiscountValue]=useState("");
  // Offline queue
  const [queueCount,setQueueCount]=useState(0);
  const [syncingQueue,setSyncingQueue]=useState(false);
  // Multi-branch
  const [activeBranch,setActiveBranchState]=useState(getActiveBranch);
  const [branches,setBranches]=useState([]);
  // Starts true when a token exists — prevents flash-to-login while /auth/me loads
  const [authLoading,setAuthLoading]=useState(()=>!!localStorage.getItem("starmart_token"));
  // Lifted to App so Settings + Inventory share the same pending transfers state
  const [shopSettings,setShopSettings]=useState(getShopSettings()); // live shop config for all roles
  const [pendingTransfers,setPendingTransfers]=useState([]);
  const menuRef=useRef(null);

  const handleLogout=useCallback(()=>{
    localStorage.removeItem("starmart_token");
    localStorage.removeItem("starmart_cart");
    localStorage.removeItem("starmart_pos_customer");
    localStorage.removeItem("starmart_delivery");
    saveActiveBranch(null);
    setUser(null); setView("pos"); setUserMenuOpen(false);
    setProducts([]); setCart([]); setSelCust(null);
    setDiscountValue(""); setBranches([]); setActiveBranchState(null);
  },[]);

  useEffect(()=>{
    // Register service worker for offline support
    if('serviceWorker' in navigator && import.meta.env.PROD){
      navigator.serviceWorker.register('/sw.js')
        .then((reg)=>{
          console.log('[SW] Registered');
          // Check for updates immediately and every 60s
          reg.update();
          setInterval(()=>reg.update(), 60000);
          // When a new SW is waiting, reload to activate it
          reg.addEventListener('updatefound',()=>{
            const newSW = reg.installing;
            if(!newSW) return;
            newSW.addEventListener('statechange',()=>{
              if(newSW.state==='installed' && navigator.serviceWorker.controller){
                // New version ready — reload silently
                newSW.postMessage({type:'SKIP_WAITING'});
                navigator.serviceWorker.addEventListener('controllerchange',()=>{
                  window.location.reload();
                },{once:true});
              }
            });
          });
        })
        .catch(e=>console.warn('[SW] Registration failed:',e));
    }
  },[]);

  useEffect(()=>{ setLogoutCallback(handleLogout); },[handleLogout]);
  useEffect(()=>{const handler=(e)=>{if(menuRef.current&&!menuRef.current.contains(e.target))setUserMenuOpen(false);};document.addEventListener("mousedown",handler);return()=>document.removeEventListener("mousedown",handler);},[]);

  const fetchProducts = useCallback((branchOverride, { skipCache = false } = {}) => {
    if (!localStorage.getItem("starmart_token")) return Promise.resolve();
    // Only serve IDB cache on initial page load (not after add/edit/delete)
    if (!skipCache) {
      idbGetAll("products").then(cached=>{ if(cached.length) setProducts(cached); }).catch(()=>{});
    }
    if(!navigator.onLine){ setProductsLoading(false); return Promise.resolve(); }
    setProductsLoading(true);
    const branch = branchOverride !== undefined ? branchOverride : getActiveBranch();
    const qs = branch ? `?branchId=${branch.id}` : "";
    return apiFetch(`/api/products${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        const normed = data.map(norm);
        setProducts(normed);
        idbClearAndPutAll("products", normed).catch(()=>{});
      })
      .catch(e => console.error("Failed to fetch products:", e))
      .finally(() => setProductsLoading(false));
  }, []);

  const handleSwitch=useCallback((newUser)=>{
    // Keep cart intact — just swap the authenticated user
    setUser(newUser);
    setView(newUser.perms.nav[0]);
    setUserMenuOpen(false);
    setShowSwitchModal(false);
    fetchProducts();
  },[fetchProducts]);

  const fetchPendingTransfers = useCallback(async () => {
    if (!localStorage.getItem("starmart_token")) return;
    if (user?.role === "cashier") return; // cashiers don't have transfer access
    try {
      const r = await apiFetch("/api/branches/transfers?status=pending&limit=50");
      if (r.ok) { const data = await r.json(); setPendingTransfers(data); }
    } catch(e) {}
  }, [user]);

  // ── Sync queued offline orders + fetch branches ──────────────────────────
  const syncQueue = useCallback(async()=>{
    const queue = await idbGetAll("queue").catch(()=>[]);
    if(!queue.length) return;
    setSyncingQueue(true);

    // Sort by queuedAt ascending — process oldest orders first to preserve sequence
    const sorted = [...queue].sort((a,b)=>(a.queuedAt||0)-(b.queuedAt||0));

    let synced=0, conflicts=0;
    for(const item of sorted){
      try{
        // Add queuedAt timestamp so backend can detect stale orders
        const payload = { ...item.payload, _queuedAt: item.queuedAt, _offlineSync: true };
        const r = await apiFetch("/api/orders",{method:"POST",body:JSON.stringify(payload)});
        if(r.ok){
          await idbDelete("queue",item.tmpId);
          synced++;
        } else {
          const err = await r.json().catch(()=>({}));
          // 409 = stock conflict — log it but don't retry endlessly
          if(r.status===409){
            conflicts++;
            console.warn("[Sync] Stock conflict on queued order:", err.error);
            // Keep in queue for manual review — show warning to user
            await idbAdd("queue",{...item, conflictError: err.error, conflictAt: Date.now()});
            await idbDelete("queue",item.tmpId);
          }
        }
      }catch{ break; } // stop if network drops again
    }

    if(synced||conflicts){
      setQueueCount(q=>Math.max(0,q-synced));
      fetchProducts(); // refresh stock after sync
    }
    if(conflicts>0){
      console.warn(`[Sync] ${conflicts} order(s) had stock conflicts and need review.`);
    }
    setSyncingQueue(false);
  },[fetchProducts]);

  const handleBranchChange = useCallback((b)=>{
    setActiveBranchState(b);
    saveActiveBranch(b);
    fetchProducts(b); // immediately reload stock for the new branch
  },[fetchProducts]);

  // When coming back online: recount queue, sync, refresh products + branches
  useEffect(()=>{
    if(!online||!user) return;
    idbGetAll("queue").then(q=>setQueueCount(q.length)).catch(()=>{});
    syncQueue();
    fetchProducts();
    fetchPendingTransfers();
    fetchBranches();
  },[online,user]); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: load queue count from IDB even before network comes back
  useEffect(()=>{
    idbGetAll("queue").then(q=>setQueueCount(q.length)).catch(()=>{});
  },[]);

  // Persist cart + customer to localStorage so refresh doesn't lose them
  useEffect(()=>{
    try{ localStorage.setItem("starmart_cart", JSON.stringify(cart)); }catch{}
    // Auto-reset delivery when cart is emptied — prevents fee carrying over to next sale
    if(cart.length === 0 && delivery?.isDelivery){
      setDelivery({isDelivery:false,name:"",phone:"",altPhone:"",address:"",area:"",landmark:"",town:"",fee:0,notes:"",deliveryTime:""});
      localStorage.removeItem("starmart_delivery");
    }
  },[cart, delivery?.isDelivery]);

  useEffect(()=>{
    try{
      if(delivery?.isDelivery){
        localStorage.setItem("starmart_delivery", JSON.stringify(delivery));
      } else {
        localStorage.removeItem("starmart_delivery");
      }
    }catch{}
  },[delivery]);

  useEffect(()=>{
    try{
      if(selCust) localStorage.setItem("starmart_pos_customer", JSON.stringify(selCust));
      else localStorage.removeItem("starmart_pos_customer");
    }catch{}
  },[selCust]);

  // ── Auto-refresh polling ──────────────────────────────────────────────────
  // Products: every 60s (stock changes from other terminals/branches)
  useEffect(()=>{
    if(!user) return;
    const t = setInterval(()=>{ if(navigator.onLine) fetchProducts(); }, 60000);
    return ()=>clearInterval(t);
  },[user, fetchProducts]);

  // Poll pending transfers every 15 s so managers see admin approvals without refresh
  useEffect(()=>{
    if(!user) return;
    const interval = setInterval(()=>{
      if(navigator.onLine) fetchPendingTransfers();
    }, 15000);
    return ()=>clearInterval(interval);
  },[user, fetchPendingTransfers]);

  // Re-fetch data when switching views so every view is always fresh
  useEffect(()=>{
    if(!user || !navigator.onLine) return;
    if(view==="pos"||view==="inv") fetchProducts();
    if(view==="inv"||view==="settings") fetchPendingTransfers();
    if(view==="settings") fetchBranches();
  },[view, user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin=(u)=>{ setUser(u); setView(u.perms.nav[0]); fetchProducts(); fetchPendingTransfers(); syncShopSettings().then(data=>{ if(data) setShopSettings({...SHOP_DEFAULTS,...data}); }); };

  const fetchBranches = useCallback(()=>{
    if(!localStorage.getItem("starmart_token")) return;
    apiFetch("/api/branches").then(r=>r.ok?r.json():Promise.reject()).then(data=>{
      setBranches(data);
      setActiveBranchState(prev=>{
        if(!prev && data.length){ saveActiveBranch(data[0]); return data[0]; }
        if(prev){
          const fresh=data.find(b=>b.id===prev.id);
          if(fresh){ saveActiveBranch(fresh); return fresh; }
          // Branch was deleted — clear it
          saveActiveBranch(null);
          return data.length ? data[0] : null;
        }
        return null;
      });
    }).catch(()=>{});
  },[]);

  // Branches: every 2 min
  useEffect(()=>{
    if(!user) return;
    const t = setInterval(()=>{ if(navigator.onLine) fetchBranches(); }, 120000);
    return ()=>clearInterval(t);
  },[user, fetchBranches]);

  // Refresh key data when user returns to this browser tab after being away
  useEffect(()=>{
    const onVisible=()=>{
      if(document.visibilityState==="visible" && user && navigator.onLine){
        fetchProducts();
        fetchBranches();
        syncShopSettings().then(d=>{ if(d) setShopSettings({...SHOP_DEFAULTS,...d}); });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return ()=>document.removeEventListener("visibilitychange", onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user, fetchBranches, fetchProducts]);

  // Poll pending staff approvals every 20s (admin only) for nav badge
  useEffect(()=>{
    if(!user || user.role!=="admin") return;
    const fetchPending=()=>{
      apiFetch("/api/users/pending").then(r=>r.ok?r.json():null).then(d=>{
        if(d) setPendingCount(Array.isArray(d)?d.length:0);
      }).catch(()=>{});
    };
    fetchPending();
    const t = setInterval(fetchPending, 20000);
    return ()=>clearInterval(t);
  },[user]);

  const [now,setNow]=useState(new Date());
  useEffect(()=>{ const t=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(t); },[]);

  // Restore session on page refresh
  useEffect(() => {
    const token = localStorage.getItem("starmart_token");
    if (!token) return; // authLoading is already false when no token (lazy initialiser)
    apiFetch("/api/auth/me")
      .then(r => {
        // Only 401 means token is genuinely expired/invalid — clear it.
        // Any other error (500, network timeout) keeps the token so a slow
        // backend start or brief network blip doesn't log the user out.
        if (r.status === 401) { localStorage.removeItem("starmart_token"); setAuthLoading(false); return null; }
        if (!r.ok) { setAuthLoading(false); return null; }
        return r.json();
      })
      .then(data => {
        if (!data) return;
        const u = data.user;
        const perms = PERMISSIONS[u.role];
        if (!perms) { setAuthLoading(false); return; }
        setUser({ ...u, perms });
        setView(perms.nav[0]);
        fetchProducts();
        syncShopSettings().then(data=>{ if(data) setShopSettings({...SHOP_DEFAULTS,...data}); }); // pull latest settings from DB for all roles
      })
      .catch(() => {
        // Network error — keep the token, just unblock the UI.
        // The user stays on the spinner; real logout only happens on 401.
        console.warn("Session check failed (network) — keeping token");
      })
      .finally(() => setAuthLoading(false));
  }, [fetchProducts]);

  // Show a spinner while verifying the token — never flash the login page
  if(authLoading) return(
    <>
      <GlobalStyle/>
      <div style={{height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,background:C.bg}}>
        <div style={{width:40,height:40,border:`3px solid ${C.border}`,borderTopColor:C.blue,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
        <div style={{fontSize:13,color:C.text3,fontWeight:500}}>Restoring session…</div>
      </div>
    </>
  );


  if(!user) return <><GlobalStyle/><LoginPage onLogin={handleLogin}/></>;
  const perms=user.perms;
  const viewTitles={pos:"Point of Sale",inv:"Inventory",cust:"Customers",reports:"Analytics",refunds:"Refunds & Returns",security:"Security",settings:"Settings"};

  const viewSubtitles={pos:"Process sales and manage transactions",inv:"Track products and stock levels",cust:"Manage customer profiles and loyalty",reports:"Revenue insights and business analytics",refunds:"Process returns and issue refunds",security:"Audit logs, fraud detection & data backup",settings:"Configure your shop and integrations"};

  return(
    <>
      <GlobalStyle/>
      <div style={{display:"flex",height:"100vh",width:"100vw",overflow:"hidden",background:C.bg}}>
        <Sidebar view={view} setView={setView} user={user} onLogout={handleLogout} pendingCount={pendingCount}/>
        <div className="r-main-content" style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
          {/* Top bar */}
          <header className="r-header" style={{minHeight:52,background:C.sidebar,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",padding:"0 12px",gap:8,flexShrink:0,minWidth:0,overflow:"visible",position:"relative",zIndex:200}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:18,letterSpacing:"-0.02em",lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{viewTitles[view]}</div>
              <div className="r-header-subtitle" style={{fontSize:13,fontWeight:400,color:C.text2,marginTop:1,display:"flex",alignItems:"center",gap:6,overflow:"hidden",minWidth:0}}>
                {activeBranch&&branches.some(b=>b.id===activeBranch.id)&&<>
                  <span className="r-header-branch-label" style={{color:C.blue,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:200}}>
                    🏪 {branchLabel(activeBranch)}
                    {activeBranch.isHQ&&<span style={{fontSize:10,fontWeight:700,color:C.amber,background:C.amberGlow,padding:"1px 5px",borderRadius:20,marginLeft:5}}>HQ</span>}
                  </span>
                  <span style={{color:C.text3,flexShrink:0}}>·</span>
                </>}
                <span className="r-header-view-subtitle" style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{viewSubtitles[view]}</span>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {productsLoading&&<div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:6,background:C.border,fontSize:15,color:C.text3}}>
                <span style={{width:10,height:10,border:`2px solid ${C.border}`,borderTopColor:C.blue,borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>
                Syncing…
              </div>}
              {/* Branch selector */}
              <BranchSelector branches={branches} activeBranch={activeBranch} onBranchChange={handleBranchChange} user={user}/>
              {/* Online / Offline indicator */}
              <div style={{display:"flex",alignItems:"center",gap:5,padding:"4px 8px",borderRadius:6,
                background:online?C.greenGlow:"rgba(245,158,11,0.10)",
                border:`1px solid ${online?C.green+"22":"rgba(245,158,11,0.25)"}`,
                fontSize:13,color:online?C.green:C.amber,fontWeight:600,flexShrink:0}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:online?C.green:C.amber,display:"inline-block",flexShrink:0,animation:online?"none":"pulse 2s infinite"}}/>
                <span className="r-header-clock">{online?queueCount>0?`Syncing ${queueCount}…`:"Live":"Offline"}</span>
                <span style={{display:"none"}} className="r-show-xs">{online?"●":"!"}</span>
              </div>
              {/* Clock */}
              <div className="r-header-chip r-header-clock" style={{padding:"5px 10px",borderRadius:6,background:C.border,fontSize:15,color:C.text2,fontFamily:C.mono,letterSpacing:"0.04em"}}>
                {now.toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true})}
              </div>
              {/* Location */}
              <div className="r-header-chip r-header-loc" style={{padding:"5px 10px",borderRadius:6,background:C.border,fontSize:15,color:C.text2,fontWeight:500}}>🇰🇪 Nairobi</div>
              {/* New staff button for admin */}

              {perms.badge==="ADMIN"&&<button className="r-header-newstaff" onClick={()=>setShowCreateModal(true)} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:7,border:"none",background:C.blue,color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer",transition:"all 0.15s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#4F46E5"} onMouseLeave={e=>e.currentTarget.style.background=C.blue}>
                + New Staff
              </button>}
              {/* User menu */}
              <div ref={menuRef} style={{position:"relative"}}>
                <button onClick={()=>setUserMenuOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",background:userMenuOpen?C.border:"transparent",border:`1px solid ${userMenuOpen?C.border:"transparent"}`,borderRadius:8,cursor:"pointer",transition:"all 0.15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=C.border;}} onMouseLeave={e=>{if(!userMenuOpen)e.currentTarget.style.background="transparent";}}>
                  <div style={{width:28,height:28,borderRadius:8,background:perms.color,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:14,color:"#000",flexShrink:0}}>{user.name[0].toUpperCase()}</div>
                  <div className="r-header-clock">
                    <div style={{fontSize:13,fontWeight:600,lineHeight:1.2,textAlign:"left",whiteSpace:"nowrap"}}>{user.name.split(" ")[0]}</div>
                    <div style={{fontSize:11,color:perms.color,fontWeight:700,letterSpacing:"0.04em"}}>{user.role.toUpperCase()}</div>
                  </div>
                  <svg className="r-header-clock" width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={C.text3} strokeWidth={2.5}><polyline points={userMenuOpen?"18 15 12 9 6 15":"6 9 12 15 18 9"}/></svg>
                </button>
                {userMenuOpen&&(<div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:12,padding:8,minWidth:220,boxShadow:"0 16px 48px rgba(0,0,0,0.6)",zIndex:500,animation:"floatUp 0.15s ease both"}}>
                  <div style={{padding:"10px 12px 12px",borderBottom:`1px solid ${C.border}`,marginBottom:4}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:36,height:36,borderRadius:10,background:perms.color,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:16,color:"#000"}}>{user.name[0].toUpperCase()}</div>
                      <div>
                        <div style={{fontWeight:600,fontSize:16,letterSpacing:"-0.01em"}}>{user.name}</div>
                        <div style={{fontSize:14,color:C.text3,marginTop:2,fontWeight:400}}>{user.email}</div>
                        <Tag color={perms.color}>{perms.badge}</Tag>
                      </div>
                    </div>
                  </div>
                  <button onClick={()=>{setShowProfileModal(true);setUserMenuOpen(false);}}
                    style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:"transparent",border:"none",borderRadius:8,cursor:"pointer",color:C.text2,fontSize:15,fontWeight:500,transition:"background 0.15s",textAlign:"left"}}
                    onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <NavIcon path="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" size={14} color={C.text2}/>
                    My Profile
                  </button>
                  <button onClick={()=>{setShowSwitchModal(true);setUserMenuOpen(false);}}
                    style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:"transparent",border:"none",borderRadius:8,cursor:"pointer",color:C.blue,fontSize:15,fontWeight:500,transition:"background 0.15s",textAlign:"left"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.blueGlow} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <NavIcon path="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" size={14} color={C.blue}/>
                    Switch User
                  </button>
                  <div style={{height:1,background:C.border,margin:"4px 0"}}/>
                  <button onClick={handleLogout} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:"transparent",border:"none",borderRadius:8,cursor:"pointer",color:C.red,fontSize:15,fontWeight:500,transition:"background 0.15s",textAlign:"left"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.redGlow} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <NavIcon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" size={14} color={C.red}/>
                    Sign Out
                  </button>
                </div>)}
              </div>
            </div>
          </header>
          <OfflineBanner online={online} queueCount={queueCount} syncing={syncingQueue}/>
          <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
            {view==="pos"&&<ErrorBoundary name="POS">
            <POSView products={products} setProducts={setProducts} perms={perms} cart={cart} setCart={setCart} selCust={selCust} setSelCust={setSelCust} delivery={delivery} setDelivery={setDelivery} discountValue={discountValue} setDiscountValue={setDiscountValue} activeBranch={activeBranch} branches={branches} shopSettings={shopSettings} onQueueAdd={()=>setQueueCount(q=>q+1)}/>
            </ErrorBoundary>}
            {view==="inv"&&<InventoryView products={products} perms={perms} fetchProducts={fetchProducts} branches={branches} activeBranch={activeBranch} pendingTransfers={pendingTransfers} setPendingTransfers={setPendingTransfers} fetchPendingTransfers={fetchPendingTransfers} shopSettings={shopSettings} externalScanOpen={invScanOpen} onExternalScanClose={()=>setInvScanOpen(false)}/>}
            {view==="cust"&&<CustomersView perms={perms}/>}
            {view==="reports"&&<ErrorBoundary name="Analytics"><ReportsView perms={perms}/></ErrorBoundary>}
            {view==="refunds"&&<RefundsView perms={perms} branches={branches} activeBranch={activeBranch} fetchProducts={fetchProducts}/>}
            {view==="security"&&<ErrorBoundary name="Security"><SecurityView currentUser={user}/></ErrorBoundary>}
            {view==="settings"&&<SettingsView currentUser={user} fetchProducts={fetchProducts} fetchPendingTransfers={fetchPendingTransfers} setPendingTransfers={setPendingTransfers} fetchBranches={fetchBranches} onSettingsSaved={(s)=>setShopSettings({...SHOP_DEFAULTS,...s})}/>}
          </div>
        </div>
      </div>
      {/* ── Fixed Receive Stock button — visible on Stock page ── */}
      {view==="inv"&&(
        <button
          onClick={()=>setReceiveStockOpen(true)}
          style={{
            position:"fixed",
            bottom:80,
            left:"50%",
            transform:"translateX(-50%)",
            zIndex:9999,
            display:"flex",alignItems:"center",gap:8,
            padding:"12px 24px",
            borderRadius:50,
            border:"none",
            background:`linear-gradient(135deg,${C.green},#16a34a)`,
            color:"#000",
            fontSize:15,fontWeight:800,
            cursor:"pointer",
            boxShadow:"0 4px 20px rgba(34,197,94,0.5)",
            whiteSpace:"nowrap",
          }}
        >
          📷 Receive Stock
        </button>
      )}

      {showCreateModal&&<Modal title="Create Staff Account" onClose={()=>setShowCreateModal(false)}><CreateStaffForm branches={branches}/></Modal>}
      {showSwitchModal&&<SwitchUserModal onSwitch={handleSwitch} onClose={()=>setShowSwitchModal(false)}/>}
      {showProfileModal&&<ProfileModal user={user} onClose={()=>setShowProfileModal(false)} onUpdated={(updated)=>{setUser(u=>({...u,...updated}));setShowProfileModal(false);}}/> }
      {receiveStockOpen&&<ReceiveStock products={products} activeBranch={activeBranch} onClose={()=>setReceiveStockOpen(false)} onStockUpdated={()=>fetchProducts(undefined,{skipCache:true})}/>}

      {/* ── Mobile bottom navigation ──────────────────────────── */}
      <nav className="r-bnav">
        {ALL_NAV.filter(n=>perms.nav.includes(n.id)).map(n=>(
          <button key={n.id} className={`r-bnav-btn${view===n.id?" active":""}`} onClick={()=>setView(n.id)}
            style={{position:"relative",flex:"1 0 auto",minWidth:52,maxWidth:80}}>
            <div className="r-bnav-dot"/>
            {(n.id==="security"||n.id==="settings")&&pendingCount>0&&(
              <span style={{position:"absolute",top:2,right:"calc(50% - 14px)",background:C.amber,color:"#000",
                fontSize:10,fontWeight:800,padding:"0px 5px",borderRadius:20,minWidth:16,textAlign:"center",lineHeight:"16px"}}>
                {pendingCount}
              </span>
            )}
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={view===n.id?2.5:1.8} strokeLinecap="round" strokeLinejoin="round"><path d={n.icon}/></svg>
            <span className="r-bnav-label" style={{fontSize:10,fontWeight:view===n.id?700:500,color:view===n.id?"#F0F2F5":"#7A8699",letterSpacing:"0.03em",textTransform:"uppercase"}}>{n.label.split(" ")[0]}</span>
          </button>
        ))}
      </nav>
    </>
  );
}