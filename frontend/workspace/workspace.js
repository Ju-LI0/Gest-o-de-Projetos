let processes = [];
let currentUser = null;
let activeFilter = "Todos";
let libraryFilter = "Todos";
let toastTimer;

const byId = (id) => document.getElementById(id);

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
  return data;
}

function updateAccountInterface() {
  const initials = currentUser.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  byId("user-greeting").hidden = false;
  byId("top-avatar").hidden = false;
  byId("user-greeting").textContent = `Olá, ${currentUser.name.split(/\s+/)[0]}`;
  byId("top-avatar").textContent = initials;
  byId("account-button").textContent = "Sair";
  byId("profile-name").textContent = currentUser.name;
  byId("profile-role").textContent = currentUser.email;
  byId("profile-avatar").textContent = initials;
  byId("workspace-name").textContent = `Espaço de ${currentUser.name.split(/\s+/)[0]}`;
}

async function refreshProcesses() {
  const result = await apiRequest("/api/processes");
  processes = result.processes;
  renderDashboard();
  renderLibrary();
}

async function initializeApp() {
  try {
    const result = await apiRequest("/api/auth/me");
    currentUser = result.user;
    if (!currentUser) {
      window.location.replace("/login/?next=/workspace/");
      return;
    }
    updateAccountInterface();
    await refreshProcesses();
  } catch (error) {
    showToast(`Não foi possível carregar seus processos: ${error.message}`);
  }
}

function setView(view) {
  document.querySelectorAll(".page-view").forEach((page) => page.classList.toggle("active", page.id === `${view}-view`));
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const labels = { home: "Visão geral", processes: "Meus processos", suggestions: "Guia de mapeamento" };
  byId("breadcrumb-current").textContent = labels[view] || labels.home;
  if (view === "processes") renderLibrary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(timestamp));
}

function processMarkup(process) {
  const statusClass = process.status === "Finalizado" ? "status-done" : "status-pending";
  const stepCount = Array.isArray(process.steps) ? process.steps.length : 0;
  const description = process.description || `${stepCount} ${stepCount === 1 ? "etapa mapeada" : "etapas mapeadas"}`;
  return `<article class="process-row" data-process-id="${escapeAttribute(process.id)}">
    <span class="process-type-icon">${process.status === "Finalizado" ? "✓" : "▤"}</span>
    <div><div class="process-name">${escapeHtml(process.name)}</div><div class="process-description">${escapeHtml(description)}</div></div>
    <div class="process-meta">${stepCount} ${stepCount === 1 ? "etapa" : "etapas"}<small>no mapeamento</small></div>
    <div class="process-meta">${formatDate(process.updatedAt)}<small>última atualização</small></div>
    <span class="status-badge ${statusClass}">${escapeHtml(process.status)}</span>
    <button class="row-menu" aria-label="Editar ${escapeAttribute(process.name)}" title="Editar processo">···</button>
  </article>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function matchesProcess(process, filter, search) {
  const statusMatches = filter === "Todos" || process.status === filter;
  const searchMatches = !search || `${process.name} ${process.description || ""}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"));
  return statusMatches && searchMatches;
}

function updateStats() {
  const done = processes.filter((process) => process.status === "Finalizado").length;
  const pending = processes.length - done;
  byId("total-count").textContent = processes.length;
  byId("done-count").textContent = done;
  byId("pending-count").textContent = pending;
  byId("nav-count").textContent = processes.length;
  byId("all-tab-count").textContent = processes.length;
  byId("library-all-count").textContent = processes.length;
  byId("total-progress").style.width = `${processes.length ? Math.min(100, processes.length * 12) : 0}%`;
  byId("done-progress").style.width = `${processes.length ? (done / processes.length) * 100 : 0}%`;
  byId("pending-progress").style.width = `${processes.length ? (pending / processes.length) * 100 : 0}%`;
}

function renderList(containerId, emptyId, filter, search) {
  const list = byId(containerId);
  const empty = byId(emptyId);
  const filtered = processes.filter((process) => matchesProcess(process, filter, search)).sort((a, b) => b.updatedAt - a.updatedAt);
  list.innerHTML = filtered.map(processMarkup).join("");
  list.style.display = filtered.length ? "grid" : "none";
  empty.classList.toggle("visible", filtered.length === 0);
  if (filtered.length === 0 && processes.length > 0) {
    empty.classList.add("filtered-empty");
    empty.querySelector("h3").textContent = "Nenhum resultado encontrado.";
    empty.querySelector("p").textContent = "Experimente ajustar o filtro ou buscar por outro termo.";
    empty.querySelector("button").style.display = "none";
  } else {
    empty.classList.remove("filtered-empty");
    const isLibrary = containerId === "library-list";
    empty.querySelector("h3").textContent = isLibrary ? "Seu próximo processo começa aqui." : "Nenhum processo por aqui, ainda.";
    empty.querySelector("p").textContent = isLibrary
      ? "Crie um mapeamento para deixar as etapas mais claras para todo mundo."
      : "Todo processo bem desenhado começa com uma conversa. Mapeie o primeiro com a gente.";
    empty.querySelector("button").style.display = "";
  }
  list.querySelectorAll(".process-row").forEach((row) => row.addEventListener("click", (event) => {
    if (event.target.closest(".row-menu")) openEditor(row.dataset.processId);
  }));
}

function renderDashboard() {
  updateStats();
  renderList("process-list", "empty-state", activeFilter, byId("process-search").value);
}

function renderLibrary() {
  renderList("library-list", "library-empty", libraryFilter, byId("library-search").value);
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2700);
}

async function signOut() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
    window.location.assign("/home/");
  } catch (error) {
    showToast(error.message);
  }
}

function openEditor(processId = null) {
  const destination = new URL("/mapping/", window.location.origin);
  if (processId) destination.searchParams.set("id", processId);
  window.location.assign(destination);
}

function bindFilters() {
  document.querySelectorAll(".filter-tab").forEach((tab) => tab.addEventListener("click", () => {
    const isLibraryTab = tab.closest("#processes-view") !== null;
    const group = tab.closest(".filter-tabs");
    group.querySelectorAll(".filter-tab").forEach((item) => item.classList.toggle("selected", item === tab));
    if (isLibraryTab) {
      libraryFilter = tab.dataset.filter;
      renderLibrary();
    } else {
      activeFilter = tab.dataset.filter;
      renderDashboard();
    }
  }));
}

document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
document.querySelectorAll("#create-process-secondary,#empty-create,#processes-create,#library-create,#guide-create,#new-process-nav").forEach((button) => button.addEventListener("click", () => openEditor()));
byId("account-button").addEventListener("click", signOut);
byId("profile-button").addEventListener("click", signOut);
document.querySelectorAll("#sidebar-guide").forEach((button) => button.addEventListener("click", () => setView("suggestions")));
bindFilters();
renderDashboard();
renderLibrary();
initializeApp();
