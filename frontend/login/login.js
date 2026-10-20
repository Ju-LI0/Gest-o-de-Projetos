"use strict";

const form = document.getElementById("auth-form");
const errorMessage = document.getElementById("auth-error");
const submitButton = document.getElementById("submit-button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  errorMessage.hidden = true;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.elements.email.value.trim(),
        password: form.elements.password.value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Não foi possível entrar.");
    const requestedPath = new URLSearchParams(window.location.search).get("next");
    const safeNext = requestedPath === "/workspace/" || /^\/mapping\/(?:\?id=[0-9a-f-]{36})?$/i.test(requestedPath || "");
    window.location.assign(safeNext ? requestedPath : "/workspace/");
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});
