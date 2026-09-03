import type { FastifyInstance } from "fastify";

// Dashboard admin auto-contenu (HTML + JS vanilla, aucune dépendance externe,
// aucun build step) — juste assez pour voir les commandes, filtrer par
// statut, consulter le détail (événements + tentatives Cluster POS), et
// relancer manuellement une commande en erreur.
const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cluster-pos-hub — Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 0; padding: 24px; background: #0b0d12; color: #e6e8eb;
  }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    background: #1a1d24; color: #e6e8eb; border: 1px solid #2a2e38;
    border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer;
  }
  button.active { background: #2b6ef5; border-color: #2b6ef5; color: white; }
  button:hover { border-color: #2b6ef5; }
  button.retry { background: #b3452e; border-color: #b3452e; color: white; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1f232b; }
  th { color: #9aa1ad; font-weight: 500; }
  tr.order-row { cursor: pointer; }
  tr.order-row:hover { background: #12151b; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    background: #2a2e38;
  }
  .badge.received { background: #2b6ef5; }
  .badge.sent_to_pos { background: #9b59b6; }
  .badge.confirmed, .badge.preparing { background: #d4a017; color: #1a1a1a; }
  .badge.ready { background: #2ecc71; color: #1a1a1a; }
  .badge.error { background: #e74c3c; }
  .badge.cancelled { background: #555; }
  #detail {
    margin-top: 20px; padding: 14px; background: #12151b; border: 1px solid #1f232b;
    border-radius: 8px; display: none; white-space: pre-wrap; font-size: 12px;
    max-height: 50vh; overflow: auto;
  }
  .muted { color: #9aa1ad; }
  #status { font-size: 12px; color: #9aa1ad; }
</style>
</head>
<body>
  <h1>cluster-pos-hub — Commandes</h1>
  <div class="toolbar">
    <div class="filters" id="filters"></div>
    <button id="refresh">Rafraîchir</button>
    <span id="status"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Reçue</th><th>Source</th><th>Externe ID</th><th>Client</th>
        <th>Total</th><th>Statut</th><th></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="detail"></div>

<script>
(function () {
  const STATUSES = ["all", "received", "sent_to_pos", "confirmed", "preparing", "ready", "error", "cancelled"];
  const KEY_STORAGE = "cph_admin_key";
  let currentFilter = "all";

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }

  function promptForKey() {
    const key = window.prompt("Clé admin (ADMIN_API_KEY) :", getKey());
    if (key !== null) localStorage.setItem(KEY_STORAGE, key);
    return getKey();
  }

  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ "x-api-key": getKey(), "Content-Type": "application/json" }, options.headers || {});
    const res = await fetch(path, options);
    if (res.status === 401) {
      promptForKey();
      throw new Error("Unauthorized — clé admin invalide ou manquante");
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error("Erreur API (" + res.status + "): " + body);
    }
    return res.json();
  }

  function renderFilters() {
    const el = document.getElementById("filters");
    el.innerHTML = "";
    for (const s of STATUSES) {
      const btn = document.createElement("button");
      btn.textContent = s;
      if (s === currentFilter) btn.classList.add("active");
      btn.onclick = () => { currentFilter = s; loadOrders(); };
      el.appendChild(btn);
    }
  }

  function fmtMoney(n) {
    return Number(n).toFixed(2);
  }

  function text(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function loadOrders() {
    renderFilters();
    const statusEl = document.getElementById("status");
    statusEl.textContent = "Chargement…";
    try {
      const path = currentFilter === "all" ? "/orders" : "/orders?status=" + currentFilter;
      const data = await api(path);
      const tbody = document.getElementById("rows");
      tbody.innerHTML = "";
      for (const o of data.orders) {
        const tr = document.createElement("tr");
        tr.className = "order-row";
        tr.onclick = () => showDetail(o.id);
        tr.innerHTML =
          "<td class='muted'>" + new Date(o.createdAt).toLocaleString() + "</td>" +
          "<td>" + text(o.source) + "</td>" +
          "<td>" + text(o.externalId) + "</td>" +
          "<td>" + text(o.customerName) + "</td>" +
          "<td>$" + fmtMoney(o.total) + "</td>" +
          "<td><span class='badge " + text(o.status) + "'>" + text(o.status) + "</span></td>" +
          "<td></td>";
        if (o.status === "error") {
          const btn = document.createElement("button");
          btn.textContent = "Relancer";
          btn.className = "retry";
          btn.onclick = (ev) => { ev.stopPropagation(); retry(o.id); };
          tr.lastElementChild.appendChild(btn);
        }
        tbody.appendChild(tr);
      }
      statusEl.textContent = data.orders.length + " commande(s) — " + new Date().toLocaleTimeString();
    } catch (err) {
      statusEl.textContent = String(err.message || err);
    }
  }

  async function retry(id) {
    try {
      await api("/orders/" + id + "/retry", { method: "POST" });
      loadOrders();
    } catch (err) {
      alert(String(err.message || err));
    }
  }

  async function showDetail(id) {
    const detail = document.getElementById("detail");
    detail.style.display = "block";
    detail.textContent = "Chargement…";
    try {
      const data = await api("/orders/" + id);
      detail.textContent = JSON.stringify(data.order, null, 2);
    } catch (err) {
      detail.textContent = String(err.message || err);
    }
  }

  document.getElementById("refresh").onclick = loadOrders;
  if (!getKey()) {
    // Ne bloque pas l'affichage — la 1ère requête 401 déclenchera le prompt.
  }
  loadOrders();
  setInterval(loadOrders, 10000);
})();
</script>
</body>
</html>
`;

export async function registerDashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(DASHBOARD_HTML);
  });
}
