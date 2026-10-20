"use strict";

const story = document.querySelector(".story");
const steps = [...document.querySelectorAll(".story-step")];
const nodes = [...document.querySelectorAll(".visual-node")];
const captions = [
  "Entendendo o gatilho",
  "Mapeando as atividades",
  "Identificando decisões",
  "Encontrando oportunidades",
  "Definindo a conclusão",
  "Revisando o processo"
];
const range = document.getElementById("progress-range");
const progressLabel = document.getElementById("progress-label");
const railFill = document.getElementById("flow-rail-fill");
const heroNodes = [...document.querySelectorAll(".map-node")];
const heroConnector = document.querySelector(".connector-progress");
const hero = document.querySelector(".hero");
const heroBackground = document.querySelector(".hero-background");
const heroMap = document.getElementById("hero-map");
const visual = document.getElementById("story-visual");
let activeStep = 0;
let frame = 0;

function updateStory() {
  const top = story.getBoundingClientRect().top + window.scrollY;
  const end = Math.max(top + 1, top + story.offsetHeight - window.innerHeight);
  const progress = Math.max(0, Math.min(100, ((window.scrollY - top) / (end - top)) * 100));
  progressLabel.textContent = `${Math.round(progress)}%`;
  range.value = String(Math.round(progress));
  range.style.setProperty("--progress", `${progress}%`);

  const anchor = window.innerHeight * (window.innerWidth <= 760 ? 0.8 : 0.52);
  let closest = Infinity;
  steps.forEach((step, index) => {
    const rect = step.getBoundingClientRect();
    const distance = Math.abs((rect.top + rect.height / 2) - anchor);
    if (distance < closest) {
      closest = distance;
      activeStep = index;
    }
  });
  steps.forEach((step, index) => step.classList.toggle("active", activeStep === index));
  nodes.forEach((node, index) => {
    node.classList.toggle("active", activeStep === index);
    node.classList.toggle("passed", index < activeStep);
  });
  const mapStep = Math.min(heroNodes.length - 1, Math.floor(activeStep * heroNodes.length / steps.length));
  heroNodes.forEach((node, index) => {
    node.classList.toggle("active", index === mapStep);
    node.classList.toggle("passed", index < mapStep);
  });
  heroConnector.style.strokeDashoffset = String(400 - (400 * mapStep / (heroNodes.length - 1)));
  document.getElementById("visual-step").textContent = `Etapa ${activeStep + 1} de ${steps.length}`;
  document.getElementById("visual-caption").textContent = captions[activeStep];
  railFill.style.height = `${(activeStep / (steps.length - 1)) * 100}%`;
}

window.addEventListener("scroll", () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    updateStory();
    const progress = Math.max(0, Math.min(1, window.scrollY / Math.max(1, hero.offsetHeight)));
    document.documentElement.style.setProperty("--scroll-glow", `${progress * 20}px`);
  });
}, { passive: true });

range.addEventListener("input", () => {
  const top = story.getBoundingClientRect().top + window.scrollY;
  const end = Math.max(top, top + story.offsetHeight - window.innerHeight);
  window.scrollTo({ top: top + (end - top) * (Number(range.value) / 100), behavior: "smooth" });
});

hero.addEventListener("pointermove", (event) => {
  const bounds = hero.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * 100;
  const y = ((event.clientY - bounds.top) / bounds.height) * 100;
  heroBackground.style.setProperty("--pointer-x", `${x}%`);
  heroBackground.style.setProperty("--pointer-y", `${y}%`);
  heroBackground.style.setProperty("--drift-x", `${(x - 50) * -0.08}px`);
  heroBackground.style.setProperty("--drift-y", `${(y - 50) * -0.08}px`);
  heroMap.style.setProperty("--map-x", `${(x - 50) * 0.035}px`);
  heroMap.style.setProperty("--map-y", `${(y - 50) * 0.035}px`);
});

hero.addEventListener("pointerleave", () => {
  heroBackground.style.removeProperty("--pointer-x");
  heroBackground.style.removeProperty("--pointer-y");
  heroBackground.style.removeProperty("--drift-x");
  heroBackground.style.removeProperty("--drift-y");
  heroMap.style.removeProperty("--map-x");
  heroMap.style.removeProperty("--map-y");
});

visual.addEventListener("pointermove", (event) => {
  const bounds = visual.getBoundingClientRect();
  visual.style.setProperty("--visual-x", `${(event.clientX - bounds.left - bounds.width / 2) * 0.012}px`);
  visual.style.setProperty("--visual-y", `${(event.clientY - bounds.top - bounds.height / 2) * 0.012}px`);
});
visual.addEventListener("pointerleave", () => {
  visual.style.removeProperty("--visual-x");
  visual.style.removeProperty("--visual-y");
});

async function updateAccountLinks() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) return;
    const result = await response.json();
    if (!result.user) return;
    const actions = document.querySelector(".site-actions");
    const loginLink = document.getElementById("login-link");
    loginLink.textContent = "Meu espaço";
    loginLink.href = "/workspace/";
    document.querySelectorAll("#header-cta,#hero-cta,#story-cta").forEach((link) => {
      link.href = "/workspace/";
      link.innerHTML = 'Acessar meu espaço <span>→</span>';
    });
    actions.setAttribute("aria-label", `Conectado como ${result.user.name}`);
  } catch (error) {
    console.error("Não foi possível verificar a sessão.", error);
  }
}

updateStory();
updateAccountLinks();
