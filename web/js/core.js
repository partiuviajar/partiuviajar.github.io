// Base do app: Supabase, estado compartilhado, formatação e utilidades.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// estado compartilhado entre as telas
export const S = {
  session: null,
  params: new URLSearchParams(), // parâmetros depois do "?" no endereço (#/nova?dest=BUE)
  current: null,                  // dados da tela aberta, usados pelos botões
  seq: 0,                         // evita que uma tela antiga sobrescreva a nova
};

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pad = (n) => String(n).padStart(2, "0");
export const brl = (v) => (v == null || !isFinite(v) ? "–" : "R$ " + Math.round(Number(v)).toLocaleString("pt-BR"));
export const compactBrl = (v) => { const n = Math.round(Number(v)); return n >= 10000 ? (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k" : (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k"; };
export const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const parseDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => isoOf(new Date());
export const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
export const fmtDay = (iso) => { const d = parseDate(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} (${WD[d.getDay()]})`; };
export const fmtShort = (iso) => { const d = parseDate(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
export const fmtMonth = (iso) => { const d = parseDate(iso); return `${MONTHS[d.getMonth()]} de ${d.getFullYear()}`; };
export const fmtDateTime = (ts) => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
export const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const pct = (price, normal) => (normal ? ((normal - price) / normal) * 100 : null);
export const stopsLabel = (s) => (s == null ? "" : s === 0 ? "direto" : `${s} escala${s > 1 ? "s" : ""}`);
export const sourceLabel = (s) => (s === "google" ? "Google Flights" : s === "aviasales" ? "Aviasales" : s || "");
export const place = (r, which) => r[`${which}_label`] || r[which];
export const plain = (s) => String(s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function ago(ts) {
  if (!ts) return "nunca";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

// companhias aéreas mais comuns (códigos IATA)
const AIRLINES = { LA: "LATAM", JJ: "LATAM", G3: "GOL", AD: "Azul", JA: "JetSMART", WJ: "JetSMART", AR: "Aerolíneas Argentinas", FO: "Flybondi", H2: "SKY", CM: "Copa", AV: "Avianca", TP: "TAP", AF: "Air France", KL: "KLM", IB: "Iberia", UX: "Air Europa", AA: "American", UA: "United", DL: "Delta", LH: "Lufthansa", LX: "Swiss", BA: "British Airways", AZ: "ITA", EK: "Emirates", QR: "Qatar", TK: "Turkish", AC: "Air Canada", AM: "Aeroméxico", ET: "Ethiopian", ZP: "Paranair", "2Z": "Voepass", DM: "Arajet", "4M": "LATAM" };
export const airlineName = (c) => AIRLINES[c] || c || "";

// bandeira a partir do código do país (BR → 🇧🇷)
export const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : "🏳️");

// ---------------------------------------------------------------------------
// Supabase e mensagens
// ---------------------------------------------------------------------------
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

export function friendlyError(error) {
  const m = error?.message || String(error);
  if (/Limite de \d+ rotas/.test(m)) return "Você já tem 10 rotas ativas. Pause ou apague uma antes.";
  if (/row-level security|permission denied/i.test(m)) return "Este e-mail não tem permissão para usar o app.";
  if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
  if (/already registered/i.test(m)) return "Esse e-mail já tem conta. Use “Entrar”.";
  if (/Email not confirmed/i.test(m)) return "Confirme seu e-mail pelo link que enviamos e tente de novo.";
  if (/Password should be/i.test(m)) return "A senha precisa ter pelo menos 6 caracteres.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão. Verifique a internet.";
  return m;
}

// cache curto das leituras pesadas: trocar de aba fica instantâneo; quem altera dados chama invalidate()
const memo = new Map();
export function cached(key, fn, ttl = 60000) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = Promise.resolve().then(fn);
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}
export const invalidate = (prefix = "") => { for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k); };

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Destinos (preparados pelo robô: foto, resumo, pontos turísticos, passeios…)
// ---------------------------------------------------------------------------
const destCache = new Map();
export async function loadDestinations(codes, cols = "code,name,country_code,country_name,thumb,lat,lon") {
  const uniq = [...new Set(codes.filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const rows = await q(sb.from("destinations").select(cols).in("code", uniq));
    for (const r of rows) destCache.set(r.code, { ...destCache.get(r.code), ...r });
    return Object.fromEntries(rows.map((r) => [r.code, r]));
  } catch { return {}; }
}

// miniaturas da Wikimedia aceitam alguns tamanhos fixos (330, 500, 960, 1280…)
export const photo = (d, size = 500) => (d?.thumb ? d.thumb.replace(/\/\d+px-/, `/${size}px-`) : null);
export const bg = (url) => (url ? `style="background-image:url('${esc(url)}')"` : "");

// ---------------------------------------------------------------------------
// Favoritos (guias, passeios e hospedagens)
// ---------------------------------------------------------------------------
export const favs = { rows: [], set: new Set(), loaded: false };
const favKey = (kind, key) => `${kind}:${key}`;
export async function loadFavs(force = false) {
  if (favs.loaded && !force) return favs;
  try {
    favs.rows = await q(sb.from("favorites").select("*").order("created_at", { ascending: false }));
    favs.set = new Set(favs.rows.map((r) => favKey(r.kind, r.key)));
  } catch { favs.rows = []; favs.set = new Set(); }
  favs.loaded = true;
  return favs;
}
export const isFav = (kind, key) => favs.set.has(favKey(kind, key));
// botão de coração: os dados vão nos atributos; app.js trata o clique em qualquer tela
export function favBtn(kind, key, { title, subtitle = "", photo = "", link = "" }, cls = "") {
  const on = isFav(kind, key);
  return `<button type="button" class="fav-btn ${cls} ${on ? "on" : ""}" aria-pressed="${on}" aria-label="${on ? "Remover dos favoritos" : "Salvar nos favoritos"}"
    data-kind="${esc(kind)}" data-key="${esc(key)}" data-title="${esc(title)}" data-sub="${esc(subtitle)}" data-photo="${esc(photo || "")}" data-link="${esc(link || "")}">${HEART}</button>`;
}
const HEART = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`;
export const heartIcon = HEART;
export async function toggleFav(btn) {
  const { kind, key, title, sub, photo, link } = btn.dataset;
  const on = !isFav(kind, key);
  const paint = (v) => document.querySelectorAll(".fav-btn").forEach((b) => {
    if (b.dataset.kind === kind && b.dataset.key === key) { b.classList.toggle("on", v); b.setAttribute("aria-pressed", String(v)); }
  });
  paint(on);
  try {
    if (on) {
      const row = await q(sb.from("favorites").upsert({ kind, key, title, subtitle: sub || null, photo: photo || null, link: link || null }, { onConflict: "kind,key" }).select("*").single());
      favs.rows.unshift(row); favs.set.add(favKey(kind, key));
      toast("❤️ Salvo nos favoritos");
    } else {
      await q(sb.from("favorites").delete().eq("kind", kind).eq("key", key));
      favs.rows = favs.rows.filter((r) => !(r.kind === kind && r.key === key)); favs.set.delete(favKey(kind, key));
      toast("Removido dos favoritos");
    }
  } catch (err) { paint(!on); toast(friendlyError(err)); }
}

// nome de quem usa (Ajustes → "Como quer ser chamado")
export const userName = () => S.session?.user?.user_metadata?.name || "viajante";
