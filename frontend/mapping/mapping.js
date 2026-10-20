"use strict";

const suggestions = [
  "Comece descrevendo o que dá início ao seu processo. Um bom gatilho ajuda a equipe a saber quando agir.",
  "Quem participa de cada atividade? Identificar os responsáveis ajuda a revelar esperas e pontos de passagem.",
  "Se o caminho muda conforme uma resposta, adicione uma etapa de decisão e deixe cada possibilidade clara.",
  "Procure tarefas repetitivas, como notificações e cópia de dados. Elas podem ser boas candidatas à automação.",
  "Converse com quem executa a rotina no dia a dia. O processo real pode ser diferente do que está no papel."
];
const stepDefaults = { Atividade: "Nova atividade", Decisão: "Nova decisão", Automação: "Nova automação" };
const stepIcons = { Início: "◉", Atividade: "▤", Decisão: "◇", Automação: "✳", Conclusão: "◎" };
const stepClasses = { Início: "start-node", Decisão: "decision-node", Automação: "automation-node", Conclusão: "end-node" };
const byId = (id) => document.getElementById(id);
let currentUser = null;
let editingId = new URLSearchParams(window.location.search).get("id");
let steps = [];
let suggestionIndex = 0;
let zoom = 100;
let pendingStepAction = null;
let toastTimer;

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
  return data;
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function renderSteps() {
  const flow = byId("flow-steps");
  byId("step-total").textContent = steps.length;
  flow.classList.toggle("visible", steps.length > 0);
  byId("canvas-empty").style.display = steps.length ? "none" : "flex";
  const displayedSteps = steps.length
    ? [{ type: "Início", name: "Início", fixed: true }, ...steps.map((step, stepIndex) => ({ ...step, stepIndex })), { type: "Conclusão", name: "Conclusão", fixed: true }]
    : [];
  flow.innerHTML = displayedSteps.map((step, index) => {
    const nodeClass = stepClasses[step.type] || "";
    const connector = index < displayedSteps.length - 1
      ? `<span class="step-connector"><button class="step-add" data-index="${step.fixed ? 0 : step.stepIndex + 1}" aria-label="Adicionar etapa aqui">＋</button></span>`
      : "";
    const controls = step.fixed ? "" : `<button class="step-remove" data-remove="${step.stepIndex}" aria-label="Remover etapa">×</button>`;
    return `<div class="step-node-wrap"><div class="step-node ${nodeClass}" ${step.fixed ? "" : `data-edit="${step.stepIndex}"`}>
      ${controls}<span class="step-node-icon">${stepIcons[step.type] || "▤"}</span>
      <span class="step-node-name" title="${escapeHtml(step.name)}">${escapeHtml(step.name)}</span>
    </div>${connector}</div>`;
  }).join("");
  flow.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    steps.splice(Number(button.dataset.remove), 1);
    renderSteps();
  }));
  flow.querySelectorAll(".step-node[data-edit]").forEach((node) => node.addEventListener("dblclick", () => renameStep(Number(node.dataset.edit))));
  flow.querySelectorAll(".step-add").forEach((button) => button.addEventListener("click", () => addStep("Atividade", Number(button.dataset.index))));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function addStep(type, position = steps.length) {
  openStepNameDialog({ mode: "add", type, position });
}

function renameStep(index) {
  openStepNameDialog({ mode: "rename", index });
}

function openStepNameDialog(action) {
  pendingStepAction = action;
  const isRename = action.mode === "rename";
  const step = isRename ? steps[action.index] : null;
  byId("step-name-title").textContent = isRename ? "Editar etapa" : `Adicionar ${action.type.toLocaleLowerCase("pt-BR")}`;
  byId("step-name-description").textContent = isRename ? "Atualize o nome para manter o mapa fácil de entender." : "Escolha um nome claro e fácil de reconhecer.";
  byId("step-name-input").value = step ? step.name : stepDefaults[action.type];
  byId("confirm-step-name").innerHTML = isRename ? "Salvar alteração <span>→</span>" : "Adicionar etapa <span>→</span>";
  byId("step-name-modal").classList.add("open");
  byId("step-name-modal").setAttribute("aria-hidden", "false");
  setTimeout(() => {
    byId("step-name-input").focus();
    byId("step-name-input").select();
  }, 50);
}

function closeStepNameDialog() {
  byId("step-name-modal").classList.remove("open");
  byId("step-name-modal").setAttribute("aria-hidden", "true");
  pendingStepAction = null;
}

function saveStepName(event) {
  event.preventDefault();
  const name = byId("step-name-input").value.trim();
  if (!name) {
    showToast("Digite um nome para a etapa.");
    byId("step-name-input").focus();
    return;
  }
  if (pendingStepAction.mode === "rename") steps[pendingStepAction.index] = { ...steps[pendingStepAction.index], name: name.slice(0, 48) };
  else steps.splice(pendingStepAction.position, 0, { type: pendingStepAction.type, name: name.slice(0, 48) });
  closeStepNameDialog();
  renderSteps();
}

function updateTitle() {
  const name = byId("process-name").value.trim();
  byId("canvas-process-name").textContent = name || "Novo processo";
  byId("editor-breadcrumb-title").textContent = name || (editingId ? "Editar mapeamento" : "Novo mapeamento");
}

async function saveProcess(status) {
  const name = byId("process-name").value.trim();
  if (!name) {
    byId("process-name").focus();
    showToast("Dê um nome ao processo antes de salvar.");
    return;
  }
  const buttons = [byId("save-pending"), byId("save-done")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const payload = { name: name.slice(0, 70), status, steps: steps.map((step) => ({ ...step })) };
    const route = editingId ? `/api/processes/${encodeURIComponent(editingId)}` : "/api/processes";
    await apiRequest(route, { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) });
    window.location.assign("/workspace/");
  } catch (error) {
    showToast(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function initializeMapping() {
  try {
    const session = await apiRequest("/api/auth/me");
    currentUser = session.user;
    if (!currentUser) {
      window.location.replace(`/login/?next=${encodeURIComponent("/mapping/" + window.location.search)}`);
      return;
    }
    if (editingId) {
      const { processes } = await apiRequest("/api/processes");
      const existing = processes.find((process) => process.id === editingId);
      if (!existing) {
        showToast("Esse mapeamento não foi encontrado.");
        setTimeout(() => window.location.assign("/workspace/"), 1000);
        return;
      }
      byId("process-name").value = existing.name;
      steps = existing.steps.map((step) => ({ ...step }));
      updateTitle();
    }
    renderSteps();
  } catch (error) {
    showToast(`Não foi possível carregar o mapeamento: ${error.message}`);
  }
}

document.querySelectorAll(".palette-item").forEach((button) => button.addEventListener("click", () => addStep(button.dataset.step)));
byId("step-name-form").addEventListener("submit", saveStepName);
byId("cancel-step-name").addEventListener("click", closeStepNameDialog);
byId("step-name-modal").addEventListener("click", (event) => { if (event.target === byId("step-name-modal")) closeStepNameDialog(); });
byId("process-name").addEventListener("input", updateTitle);
byId("save-pending").addEventListener("click", () => saveProcess("Pendente"));
byId("save-done").addEventListener("click", () => saveProcess("Finalizado"));
byId("next-suggestion").addEventListener("click", () => {
  suggestionIndex = (suggestionIndex + 1) % suggestions.length;
  byId("suggestion-text").textContent = suggestions[suggestionIndex];
});
byId("reset-canvas").addEventListener("click", () => {
  if (!steps.length || window.confirm("Remover todas as etapas deste mapeamento?")) {
    steps = [];
    renderSteps();
  }
});
byId("zoom-in").addEventListener("click", () => setZoom(Math.min(130, zoom + 10)));
byId("zoom-out").addEventListener("click", () => setZoom(Math.max(70, zoom - 10)));
function setZoom(value) {
  zoom = value;
  byId("zoom-value").textContent = `${zoom}%`;
  byId("canvas-content").style.transform = `scale(${zoom / 100})`;
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && byId("step-name-modal").classList.contains("open")) closeStepNameDialog();
});
initializeMapping();
