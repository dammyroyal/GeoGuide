/* =========================================================
   GEOGUIDE — ROCKS & MINERALS
   Main JavaScript | app.js

   Handles:
   - Authentication interface
   - Navigation and mobile sidebar
   - Rock identification
   - AI field-note organization
   - Saved observations
   - Profile and search
   - Backend API communication

   IMPORTANT:
   This file expects a backend API at /api.
   The backend, Supabase and Gemini still need configuration.
   ========================================================= */

"use strict";

/* =========================================================
   1. CONFIGURATION AND SHARED STATE
   ========================================================= */

const API_BASE = "http://localhost:5000/api";

const state = {
  user: null,
  observations: [],
  currentDraft: null,
  editingObservationId: null,
  pendingDeleteId: null,
  lastRockIdentification: null,
  isLoadingObservations: false
};

const $ = (selector, parent = document) =>
  parent.querySelector(selector);

const $$ = (selector, parent = document) =>
  [...parent.querySelectorAll(selector)];

const byId = (id) => document.getElementById(id);

const hasElement = (id) => Boolean(byId(id));

/* =========================================================
   2. GENERAL UTILITIES
   ========================================================= */

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return replacements[character];
  });
}

function setMessage(elementOrId, message, type = "info") {
  const element =
    typeof elementOrId === "string"
      ? byId(elementOrId)
      : elementOrId;

  if (!element) return;

  element.textContent = message || "";
  element.classList.remove(
    "success-text",
    "error-text",
    "warning-text"
  );

  if (type === "success") {
    element.classList.add("success-text");
  } else if (type === "error") {
    element.classList.add("error-text");
  } else if (type === "warning") {
    element.classList.add("warning-text");
  }
}

function setButtonLoading(button, loading, loadingText = "Please wait...") {
  if (!button) return;

  if (loading) {
    button.dataset.originalText = button.textContent.trim();
    button.disabled = true;
    button.textContent = loadingText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function formatDate(value) {
  if (!value) return "Date not recorded";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function getInitials(name = "Explorer") {
  return String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "U";
}

function showError(error, fallback = "Something went wrong.") {
  console.error("[GeoGuide]", error);

  if (!navigator.onLine) {
    return "You appear to be offline. Check your internet connection and try again.";
  }

  if (error instanceof TypeError) {
    return "Could not reach the GeoGuide server. Check that the backend is running.";
  }

  return error?.message || fallback;
}

/* =========================================================
   3. BACKEND API HELPER
   ========================================================= */

/*
Expected backend routes:

POST   /api/auth/signup
POST   /api/auth/signin
POST   /api/auth/signout
GET    /api/auth/me
POST   /api/auth/forgot-password

POST   /api/ai/identify-rock
POST   /api/ai/organize-notes

GET    /api/observations
POST   /api/observations
GET    /api/observations/:id
PUT    /api/observations/:id
DELETE /api/observations/:id

PUT    /api/profile

These routes must be implemented in the backend.
The browser must never receive your Gemini secret key.
*/

function clearStoredSession() {
  localStorage.removeItem("geoguide_session");
  sessionStorage.removeItem("geoguide_session");
}

function getStoredSession() {
  const raw =
    localStorage.getItem("geoguide_session") ||
    sessionStorage.getItem("geoguide_session");

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    clearStoredSession();
    return null;
  }
}

async function refreshAuthSession(refreshToken) {
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ refreshToken })
    });

    if (!response.ok) return null;

    const data = await response.json();

    if (data?.session?.access_token && data?.user) {
      const sessionData = JSON.stringify(data.session);

      if (localStorage.getItem("geoguide_session")) {
        localStorage.setItem("geoguide_session", sessionData);
      } else {
        sessionStorage.setItem("geoguide_session", sessionData);
      }

      return data;
    }
  } catch (error) {
    console.warn("Session refresh error:", error.message);
  }

  return null;
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  headers.set("Accept", "application/json");

  const session = getStoredSession();

  if (session?.access_token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "same-origin"
  });

  // Handle expired access token automatically
  if (
    response.status === 401 &&
    !options._isRetry &&
    !path.startsWith("/auth/signin") &&
    !path.startsWith("/auth/signup") &&
    !path.startsWith("/auth/refresh")
  ) {
    if (session?.refresh_token) {
      const refreshed = await refreshAuthSession(session.refresh_token);

      if (refreshed?.session?.access_token) {
        return apiRequest(path, {
          ...options,
          _isRetry: true,
          headers: {
            ...Object.fromEntries(headers.entries()),
            Authorization: `Bearer ${refreshed.session.access_token}`
          }
        });
      }
    }
  }

  const contentType = response.headers.get("content-type") || "";
  let result = null;

  if (contentType.includes("application/json")) {
    result = await response.json();
  } else {
    const text = await response.text();
    result = text ? { message: text } : null;
  }

  if (!response.ok) {
    let message =
      result?.error ||
      result?.message ||
      `The server returned an error (${response.status}).`;

    // Sanitize any accidental HTML error responses so HTML never renders as text
    if (
      typeof message === "string" &&
      (message.trim().startsWith("<!DOCTYPE") ||
        message.trim().startsWith("<html") ||
        message.includes("Cannot GET") ||
        message.includes("Cannot POST"))
    ) {
      message = `Server returned an error (${response.status}). Please check backend status.`;
    }

    throw new Error(message);
  }

  return result;
}

function jsonRequest(method, data) {
  return {
    method,
    body: JSON.stringify(data)
  };
}

/* =========================================================
   4. AUTHENTICATION SCREEN
   ========================================================= */

function showAuthPanel(panelName) {
  const allowedPanels = [
    "signin",
    "signup",
    "forgot-password"
  ];

  if (!allowedPanels.includes(panelName)) {
    panelName = "signin";
  }

  $$("[data-auth-form]").forEach((form) => {
    const isActive = form.dataset.authForm === panelName;
    form.hidden = !isActive;
  });

  $$("[data-auth-tab]").forEach((button) => {
    const isActive = button.dataset.authTab === panelName;

    button.classList.toggle("is-active", isActive);

    if (button.hasAttribute("role")) {
      button.setAttribute("aria-selected", String(isActive));
    }
  });

  [
    "signin-message",
    "signup-message",
    "reset-message"
  ].forEach((id) => setMessage(id, ""));

  const activeForm = $(`[data-auth-form="${panelName}"]`);

  if (activeForm) {
    const firstInput = $("input", activeForm);

    if (firstInput) {
      setTimeout(() => firstInput.focus(), 0);
    }
  }
}

function showApplication(user) {
  state.user = user || null;

  const authScreen = byId("auth-screen");
  const mainApp = byId("main-app");

  if (authScreen) authScreen.hidden = true;
  if (mainApp) mainApp.hidden = false;

  const displayName =
    user?.fullName ||
    user?.full_name ||
    user?.name ||
    user?.user_metadata?.full_name ||
    user?.email?.split("@")[0] ||
    "Explorer";

  const email = user?.email || "";

  if (hasElement("welcome-name")) {
    byId("welcome-name").textContent = displayName.split(" ")[0];
  }

  if (hasElement("header-user-name")) {
    byId("header-user-name").textContent = displayName;
  }

  if (hasElement("user-avatar")) {
    byId("user-avatar").textContent = getInitials(displayName);
  }

  if (hasElement("profile-name")) {
    byId("profile-name").value = displayName;
  }

  if (hasElement("profile-email")) {
    byId("profile-email").value = email;
  }

  navigateTo("dashboard");
  loadObservations();
}

function showSignedOut() {
  state.user = null;
  state.observations = [];
  state.currentDraft = null;
  state.editingObservationId = null;

  if (hasElement("main-app")) {
    byId("main-app").hidden = true;
  }

  if (hasElement("auth-screen")) {
    byId("auth-screen").hidden = false;
  }

  showAuthPanel("signin");
}

async function checkExistingSession() {
  try {
    const session = getStoredSession();

    if (!session) {
      showSignedOut();
      return;
    }

    if (!session?.access_token) {
      clearStoredSession();
      showSignedOut();
      return;
    }

    try {
      const result = await apiRequest("/auth/me", {
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });

      if (result?.user) {
        showApplication(result.user);
        return;
      }
    } catch (authError) {
      // If access token expired, attempt to refresh using the refresh token
      if (session?.refresh_token) {
        const refreshed = await refreshAuthSession(session.refresh_token);

        if (refreshed?.user) {
          showApplication(refreshed.user);
          return;
        }
      }
    }

    clearStoredSession();
    showSignedOut();
  } catch (error) {
    console.info("GeoGuide session check:", error.message);
    clearStoredSession();
    showSignedOut();
  }
}

/* Sign in */

async function handleSignIn(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);

  const email = byId("signin-email").value.trim();
  const password = byId("signin-password").value;
  const rememberMe = byId("remember-me").checked;

  setMessage("signin-message", "");

  if (!email || !password) {
    setMessage(
      "signin-message",
      "Enter your email address and password.",
      "error"
    );
    return;
  }

  setButtonLoading(button, true, "Signing in...");

  try {
    const result = await apiRequest(
      "/auth/signin",
      jsonRequest("POST", {
        email,
        password,
        rememberMe
      })
    );

    if (!result?.user) {
      throw new Error(
        "The server did not return an authenticated user."
      );
    }

    if (!result.session?.access_token) {
      throw new Error(
        "No login session was returned. Please try again."
      );
    }

    const sessionData = JSON.stringify(result.session);

    if (rememberMe) {
      localStorage.setItem("geoguide_session", sessionData);
      sessionStorage.removeItem("geoguide_session");
    } else {
      sessionStorage.setItem("geoguide_session", sessionData);
      localStorage.removeItem("geoguide_session");
    }

    setMessage(
      "signin-message",
      "Signed in successfully.",
      "success"
    );

    showApplication(result.user);
  } catch (error) {
    setMessage(
      "signin-message",
      showError(error, "Unable to sign in."),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* Create account */

async function handleSignUp(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);

  const fullName = byId("signup-name").value.trim();
  const email = byId("signup-email").value.trim();
  const password = byId("signup-password").value;
  const confirmPassword = byId("signup-confirm-password").value;

  setMessage("signup-message", "");

  if (!fullName || !email || !password || !confirmPassword) {
    setMessage(
      "signup-message",
      "Complete all required fields.",
      "error"
    );
    return;
  }

  if (password.length < 8) {
    setMessage(
      "signup-message",
      "Your password must contain at least 8 characters.",
      "error"
    );
    return;
  }

  if (password !== confirmPassword) {
    setMessage(
      "signup-message",
      "Your passwords do not match.",
      "error"
    );
    byId("signup-confirm-password").focus();
    return;
  }

  setButtonLoading(button, true, "Creating account...");

  try {
    const result = await apiRequest(
      "/auth/signup",
      jsonRequest("POST", {
        fullName,
        email,
        password
      })
    );

   
if (result?.user && result?.session?.access_token) {
  sessionStorage.setItem(
    "geoguide_session",
    JSON.stringify(result.session)
  );

  localStorage.removeItem("geoguide_session");

  showApplication(result.user);
} else {
  setMessage(
    "signup-message",
    result?.message ||
      "Your account request was received. Check your email if confirmation is required.",
    "success"
  );
}

  } catch (error) {
    setMessage(
      "signup-message",
      showError(error, "Unable to create your account."),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* Forgot password */

async function handleForgotPassword(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const email = byId("reset-email").value.trim();

  setMessage("reset-message", "");

  if (!email) {
    setMessage(
      "reset-message",
      "Enter the email address for your account.",
      "error"
    );
    return;
  }

  setButtonLoading(button, true, "Sending link...");

  try {
    const result = await apiRequest(
      "/auth/forgot-password",
      jsonRequest("POST", { email })
    );

    setMessage(
      "reset-message",
      result?.message ||
        "If an account exists for that address, password-reset instructions will be sent.",
      "success"
    );
  } catch (error) {
    setMessage(
      "reset-message",
      showError(error, "Unable to request a password reset."),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* Sign out */


async function handleSignOut() {
  const confirmed = window.confirm(
    "Are you sure you want to sign out of GeoGuide?"
  );

  if (!confirmed) return;

  try {
    await apiRequest("/auth/signout", {
      method: "POST"
    });
  } catch (error) {
    console.warn("GeoGuide sign-out request:", error.message);
  } finally {
    clearStoredSession();
    showSignedOut();
  }
}


/* Password visibility */

function setupPasswordToggles() {
  $$("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = byId(button.dataset.passwordToggle);

      if (!input) return;

      const shouldShow = input.type === "password";

      input.type = shouldShow ? "text" : "password";

      button.setAttribute(
        "aria-label",
        shouldShow ? "Hide password" : "Show password"
      );

      button.setAttribute(
        "aria-pressed",
        String(shouldShow)
      );
    });
  });
}

/* =========================================================
   5. PAGE NAVIGATION
   ========================================================= */

function navigateTo(viewName) {
  const target = byId(`view-${viewName}`);

  if (!target) {
    console.warn(`GeoGuide page not found: ${viewName}`);
    return;
  }

  $$(".page-view").forEach((page) => {
    const isActive = page === target;

    page.classList.toggle("is-visible", isActive);
    page.hidden = !isActive;
  });

  $$("[data-view]").forEach((button) => {
    if (!button.classList.contains("nav-link")) return;

    const isActive = button.dataset.view === viewName;

    button.classList.toggle("is-active", isActive);

    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  closeMobileSidebar();

  window.scrollTo({
    top: 0,
    behavior: window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches ? "auto" : "smooth"
  });

  if (viewName === "observations") {
    loadObservations();
  }

  if (viewName === "field-tools") {
    initGeoGuideFieldTools();
  }
}

function openMobileSidebar() {
  const sidebar = byId("sidebar");
  const button = byId("mobile-menu-button");

  if (!sidebar || !button) return;

  sidebar.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", "Close navigation");
}

function closeMobileSidebar() {
  const sidebar = byId("sidebar");
  const button = byId("mobile-menu-button");

  if (!sidebar || !button) return;

  sidebar.classList.remove("is-open");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Open navigation");
}

function toggleMobileSidebar() {
  const sidebar = byId("sidebar");

  if (!sidebar) return;

  if (sidebar.classList.contains("is-open")) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
}

function setupNavigation() {
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");

    if (viewButton) {
      event.preventDefault();
      navigateTo(viewButton.dataset.view);
    }

    const authButton = event.target.closest("[data-auth-tab]");

    if (authButton) {
      event.preventDefault();
      showAuthPanel(authButton.dataset.authTab);
    }

    const openPanelButton = event.target.closest("[data-open-panel]");

    if (openPanelButton) {
      event.preventDefault();
      showAuthPanel(openPanelButton.dataset.openPanel);
    }
  });

  byId("mobile-menu-button")?.addEventListener(
    "click",
    toggleMobileSidebar
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMobileSidebar();
    }
  });

  document.addEventListener("click", (event) => {
    const sidebar = byId("sidebar");
    const menuButton = byId("mobile-menu-button");

    if (!sidebar || !menuButton) return;

    const isMobile = window.matchMedia("(max-width: 900px)").matches;

    if (
      isMobile &&
      sidebar.classList.contains("is-open") &&
      !sidebar.contains(event.target) &&
      !menuButton.contains(event.target)
    ) {
      closeMobileSidebar();
    }
  });
}

/* =========================================================
   6. CONDITIONAL ROCK IDENTIFIER FIELDS
   ========================================================= */

function setupConditionalRockFields() {
  const texture = byId("rock-texture");
  const grainSize = byId("rock-grain-size");

  function updateConditionalField(select, wrapperId, inputId, specialValue) {
    if (!select) return;

    const wrapper = byId(wrapperId);
    const input = byId(inputId);

    if (!wrapper || !input) return;

    const show = select.value === specialValue;

    wrapper.hidden = !show;
    input.required = show;

    if (!show) {
      input.value = "";
    }
  }

  texture?.addEventListener("change", () => {
    updateConditionalField(
      texture,
      "other-texture-wrap",
      "other-texture",
      "Other"
    );
  });

  grainSize?.addEventListener("change", () => {
    updateConditionalField(
      grainSize,
      "other-grain-wrap",
      "other-grain-size",
      "Other / uncertain"
    );
  });
}

/* =========================================================
   7. ROCK IDENTIFIER
   ========================================================= */

function getRockIdentifierInput() {
  const form = byId("rock-identifier-form");
  const data = new FormData(form);

  const texture = data.get("texture");
  const grainSize = data.get("grainSize");

  return {
    category: data.get("rockCategory"),
    texture:
      texture === "Other"
        ? data.get("otherTexture")?.trim()
        : texture,
    grainSize:
      grainSize === "Other / uncertain"
        ? data.get("otherGrainSize")?.trim()
        : grainSize,
    color: data.get("color")?.trim(),
    environment: data.get("environment")?.trim() || ""
  };
}

function validateRockIdentifier(input) {
  if (!input.category) {
    return "Choose a rock category first.";
  }

  if (!input.texture) {
    return "Select or describe the rock texture.";
  }

  if (!input.grainSize) {
    return "Select or describe the grain size.";
  }

  if (!input.color) {
    return "Describe the rock's color.";
  }

  return "";
}

function renderRockResult(container, result) {
  if (!container) return;

  /*
  Escape text from the API before inserting it into HTML.
  Only create clickable links from validated HTTP(S) URLs.
  */

  const name = escapeHTML(
    result?.name ||
    result?.rockName ||
    "Possible match"
  );

  const explanation = escapeHTML(
    result?.reasoning ||
    result?.explanation ||
    "Review the available evidence before deciding."
  );

  const confidence = escapeHTML(
    result?.confidence ||
    result?.certainty ||
    "Tentative match"
  );

  const imageUrl = safeExternalURL(
    result?.referenceUrl ||
    result?.photoUrl ||
    result?.imageUrl
  );

  container.innerHTML = `
    <div class="primary-result">
      <span class="confidence-label">${confidence}</span>
      <h3>${name}</h3>
      <p>${explanation}</p>
      ${
        imageUrl
          ? `<p><a href="${escapeHTML(imageUrl)}"
                target="_blank" rel="noopener noreferrer">
                View reference photographs
              </a></p>`
          : ""
      }
    </div>
  `;
}

function safeExternalURL(value) {
  if (!value) return "";

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }

    return url.href;
  } catch {
    return "";
  }
}

function renderRockIdentification(result) {
  const resultsPanel = byId("rock-results");
  const primaryContainer = byId("primary-rock-result");
  const alternativesContainer = byId("alternative-rock-results");

  if (!resultsPanel || !primaryContainer || !alternativesContainer) {
    return;
  }

  const primary =
    result?.primaryMatch ||
    result?.primary ||
    result?.bestMatch ||
    result?.result ||
    result;

  renderRockResult(primaryContainer, primary);

  const alternatives =
    result?.alternatives ||
    result?.possibleMatches ||
    result?.otherMatches ||
    [];

  alternativesContainer.innerHTML = "";

  if (Array.isArray(alternatives) && alternatives.length) {
    alternativesContainer.className = "alternative-results";

    alternatives.forEach((alternative) => {
      const card = document.createElement("article");
      card.className = "content-card";

      renderRockResult(card, alternative);

      alternativesContainer.appendChild(card);
    });
  } else {
    alternativesContainer.className = "alternative-results";
    alternativesContainer.innerHTML = `
      <p class="muted">
        No additional matches were returned. More observations may help
        distinguish the specimen.
      </p>
    `;
  }

  resultsPanel.hidden = false;
  resultsPanel.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

async function handleRockIdentification(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const message = byId("rock-identifier-message");

  setMessage(message, "");

  const input = getRockIdentifierInput();
  const validationError = validateRockIdentifier(input);

  if (validationError) {
    setMessage(message, validationError, "error");
    return;
  }

  setButtonLoading(button, true, "Analyzing observations...");

  try {
    const result = await apiRequest(
      "/ai/identify-rock",
      jsonRequest("POST", input)
    );

    if (!result) {
      throw new Error("No identification result was returned.");
    }

    state.lastRockIdentification = {
      input,
      result
    };

    renderRockIdentification(result);

    setMessage(
      message,
      "Results are ready. Review the evidence and possible alternatives.",
      "success"
    );
  } catch (error) {
    setMessage(
      message,
      showError(
        error,
        "Unable to identify the rock right now."
      ),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* =========================================================
   8. FIELD NOTEBOOK — COLLECT FORM DATA
   ========================================================= */

function getNotebookInput() {
  return {
    siteNumber: byId("site-number").value.trim(),
    siteName: byId("site-name").value.trim(),
    date: byId("site-date").value,
    time: byId("site-time").value,
    latitude: byId("site-latitude").value.trim(),
    longitude: byId("site-longitude").value.trim(),
    elevation: byId("site-elevation").value,
    environment: byId("site-environment").value.trim(),
    rawNotes: byId("raw-observations").value.trim(),
    extraInstructions: byId("notebook-instructions").value.trim()
  };
}

function validateNotebookInput(input) {
  if (!input.siteNumber) {
    return "Enter the location or site number.";
  }

  if (!input.date) {
    return "Select the date of the observation.";
  }

  if (!input.rawNotes) {
    return "Enter your rough field observations.";
  }

  return "";
}

function showGeneratedNotePanel() {
  const panel = byId("generated-note-panel");

  if (panel) {
    panel.hidden = false;
  }
}

async function generateOrganizedNotes() {
  const input = getNotebookInput();
  const validationError = validateNotebookInput(input);

  if (validationError) {
    setMessage("notebook-message", validationError, "error");
    return;
  }

  setMessage("notebook-message", "");

  const form = byId("field-notebook-form");
  const button = $('button[type="submit"]', form);

  setButtonLoading(button, true, "Organizing your notes...");

  try {
    const result = await apiRequest(
      "/ai/organize-notes",
      jsonRequest("POST", input)
    );

    const organizedText =
      result?.organizedNotes ||
      result?.organizedNote ||
      result?.text ||
      result?.content;

    if (typeof organizedText !== "string" || !organizedText.trim()) {
      throw new Error("The AI returned an empty field note.");
    }

    state.currentDraft = {
      ...input,
      organizedNotes: organizedText,
      observationId: byId("observation-id").value || null
    };

    byId("generated-note").value = organizedText;

    showGeneratedNotePanel();

    setMessage(
      "notebook-message",
      "Your draft is ready. Review it before saving.",
      "success"
    );

    setMessage(
      "generated-note-message",
      "Draft generated. Check every measurement, place name and interpretation.",
      "warning"
    );

    byId("generated-note-panel").scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    setMessage(
      "notebook-message",
      showError(
        error,
        "Unable to organize the field notes."
      ),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

function clearNotebookForm() {
  const confirmed = window.confirm(
    "Clear the current form? Any unsaved changes in these fields will be lost."
  );

  if (!confirmed) return;

  byId("field-notebook-form").reset();
  byId("observation-id").value = "";

  state.currentDraft = null;
  state.editingObservationId = null;

  byId("generated-note").value = "";
  byId("generated-note-panel").hidden = true;

  setMessage("notebook-message", "");
  setMessage("generated-note-message", "");
}

async function regenerateNotes() {
  /*
  Regeneration uses the current form fields.
  The user's existing draft is not saved or overwritten remotely.
  The textarea changes only if the server returns a new draft.
  */

  const confirmed = window.confirm(
    "Generate a fresh draft from the current raw notes? Your current edited draft will be replaced."
  );

  if (!confirmed) return;

  await generateOrganizedNotes();
}

function populateNotebookForm(observation) {
  const mapping = {
    "observation-id": observation.id,
    "site-number": observation.siteNumber,
    "site-name": observation.siteName,
    "site-date": observation.date,
    "site-time": observation.time,
    "site-latitude": observation.latitude,
    "site-longitude": observation.longitude,
    "site-elevation": observation.elevation,
    "site-environment": observation.environment,
    "raw-observations": observation.rawNotes,
    "notebook-instructions": observation.extraInstructions,
    "generated-note": observation.organizedNotes
  };

  Object.entries(mapping).forEach(([id, value]) => {
    const element = byId(id);

    if (element) {
      element.value = value ?? "";
    }
  });

  state.editingObservationId = observation.id;

  state.currentDraft = {
    ...observation,
    observationId: observation.id
  };

  showGeneratedNotePanel();

  setMessage(
    "generated-note-message",
    "Editing a saved observation. Save your changes when finished.",
    "warning"
  );

  navigateTo("field-notebook");
}

function handleNotebookSubmit(event) {
  event.preventDefault();
  generateOrganizedNotes();
}

/* =========================================================
   9. SAVE OBSERVATION TO THE BACKEND
   ========================================================= */

function getObservationPayload() {
  const input = getNotebookInput();
  const organizedNotes = byId("generated-note").value.trim();

  return {
    ...input,
    organizedNotes
  };
}

async function saveObservation() {
  const payload = getObservationPayload();

  if (!payload.siteNumber || !payload.date || !payload.rawNotes) {
    setMessage(
      "generated-note-message",
      "Complete the site number, date and raw observations before saving.",
      "error"
    );
    return;
  }

  if (!payload.organizedNotes) {
    setMessage(
      "generated-note-message",
      "Generate or enter your organized field notes before saving.",
      "error"
    );
    return;
  }

  const button = byId("save-observation");

  setButtonLoading(button, true, "Saving observation...");

  setMessage("generated-note-message", "Saving...");

  try {
    const existingId =
      byId("observation-id").value ||
      state.editingObservationId;

    let result;

    if (existingId) {
      result = await apiRequest(
        `/observations/${encodeURIComponent(existingId)}`,
        jsonRequest("PUT", payload)
      );
    } else {
      result = await apiRequest(
        "/observations",
        jsonRequest("POST", payload)
      );
    }

    const savedObservation =
      result?.observation ||
      result?.data ||
      result;

    if (!savedObservation?.id) {
      throw new Error(
        "The server did not confirm that the observation was saved."
      );
    }

    byId("observation-id").value = savedObservation.id;

    state.editingObservationId = savedObservation.id;
    state.currentDraft = {
      ...payload,
      id: savedObservation.id
    };

    setMessage(
      "generated-note-message",
      "Observation saved successfully.",
      "success"
    );

    await loadObservations();
  } catch (error) {
    setMessage(
      "generated-note-message",
      showError(
        error,
        "Could not save the observation. Your current draft remains on this page."
      ),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* =========================================================
   10. OBSERVATIONS — LOAD, SEARCH AND SORT
   ========================================================= */

async function loadObservations() {
  if (!state.user || state.isLoadingObservations) return;

  state.isLoadingObservations = true;

  const container = byId("observations-list");

  try {
    const result = await apiRequest("/observations");

    const observations = Array.isArray(result)
      ? result
      : result?.observations || result?.data || [];

    state.observations = observations.map(normalizeObservation);

    renderObservations();
    renderRecentObservations();
    updateObservationCount();
  } catch (error) {
    console.error("Unable to load observations:", error);

    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">!</span>
          <strong>Could not load observations</strong>
          <p>${escapeHTML(showError(error))}</p>
          <button type="button"
                  class="button button-secondary"
                  data-action="retry-observations">
            Try again
          </button>
        </div>
      `;
    }
  } finally {
    state.isLoadingObservations = false;
  }
}

function normalizeObservation(observation) {
  return {
    id: observation.id,
    siteNumber: observation.siteNumber ?? observation.site_number ?? "",
    siteName: observation.siteName ?? observation.site_name ?? "",
    date: observation.date ?? observation.observation_date ?? "",
    time: observation.time ?? "",
    latitude: observation.latitude ?? "",
    longitude: observation.longitude ?? "",
    elevation: observation.elevation ?? "",
    environment: observation.environment ?? "",
    rawNotes: observation.rawNotes ?? observation.raw_notes ?? "",
    extraInstructions:
      observation.extraInstructions ??
      observation.extra_instructions ??
      "",
    organizedNotes:
      observation.organizedNotes ??
      observation.organized_notes ??
      "",
    createdAt: observation.createdAt ?? observation.created_at ?? "",
    updatedAt: observation.updatedAt ?? observation.updated_at ?? ""
  };
}

function getFilteredObservations() {
  const query = (
    byId("observation-search")?.value || ""
  ).trim().toLowerCase();

  const sort = byId("observation-sort")?.value || "newest";

  const filtered = state.observations.filter((observation) => {
    const searchable = [
      observation.siteNumber,
      observation.siteName,
      observation.environment,
      observation.rawNotes,
      observation.organizedNotes
    ].join(" ").toLowerCase();

    return searchable.includes(query);
  });

  filtered.sort((a, b) => {
    if (sort === "oldest") {
      return new Date(a.date || 0) - new Date(b.date || 0);
    }

    if (sort === "site") {
      return String(a.siteNumber).localeCompare(
        String(b.siteNumber),
        undefined,
        { numeric: true }
      );
    }

    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  return filtered;
}

function renderObservations() {
  const container = byId("observations-list");

  if (!container) return;

  const observations = getFilteredObservations();

  if (!observations.length) {
    const hasSearch = Boolean(
      byId("observation-search")?.value.trim()
    );

    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">☷</span>
        <strong>${
          hasSearch
            ? "No matching observations"
            : "No saved observations yet"
        }</strong>
        <p>${
          hasSearch
            ? "Try a different search term."
            : "Generate and save your first organized field note."
        }</p>
        ${
          hasSearch
            ? ""
            : `<button type="button"
                       class="button button-secondary"
                       data-view="field-notebook">
                 Create an observation
               </button>`
        }
      </div>
    `;

    return;
  }

  container.innerHTML = observations.map((observation) => {
    const title =
      observation.siteName ||
      observation.siteNumber ||
      "Untitled observation";

    const excerpt =
      observation.organizedNotes ||
      observation.rawNotes ||
      "No note text available.";

    return `
      <article class="observation-card">
        <div>
          <span class="status-label">
            ${escapeHTML(observation.siteNumber || "Field observation")}
          </span>
        </div>

        <div>
          <h3>${escapeHTML(title)}</h3>
          <div class="observation-meta">
            <span>${escapeHTML(formatDate(observation.date))}</span>
            ${
              observation.environment
                ? `<span>${escapeHTML(observation.environment)}</span>`
                : ""
            }
          </div>
        </div>

        <p>${escapeHTML(excerpt.slice(0, 240))}${
          excerpt.length > 240 ? "…" : ""
        }</p>

        <div class="observation-actions">
          <button type="button"
                  class="text-button"
                  data-action="view-observation"
                  data-id="${escapeHTML(observation.id)}">
            View
          </button>

          <button type="button"
                  class="text-button"
                  data-action="edit-observation"
                  data-id="${escapeHTML(observation.id)}">
            Edit
          </button>

          <button type="button"
                  class="text-button danger-button"
                  data-action="delete-observation"
                  data-id="${escapeHTML(observation.id)}">
            Delete
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function renderRecentObservations() {
  const container = byId("recent-observations");

  if (!container) return;

  const recent = [...state.observations]
    .sort((a, b) => {
      return new Date(b.updatedAt || b.date || 0) -
        new Date(a.updatedAt || a.date || 0);
    })
    .slice(0, 3);

  if (!recent.length) {
    container.className = "empty-state";

    container.innerHTML = `
      <span class="empty-icon">▧</span>
      <strong>No saved observations yet</strong>
      <p>Your saved field records will appear here.</p>
      <button class="button button-secondary"
              type="button"
              data-view="field-notebook">
        Create your first observation
      </button>
    `;

    return;
  }

  container.className = "recent-observation-list";

  container.innerHTML = recent.map((observation) => `
    <article class="observation-card">
      <div>
        <h3>${escapeHTML(
          observation.siteName ||
          observation.siteNumber ||
          "Field observation"
        )}</h3>

        <p>${escapeHTML(formatDate(observation.date))}</p>
      </div>

      <button type="button"
              class="text-button"
              data-action="view-observation"
              data-id="${escapeHTML(observation.id)}">
        View note →
      </button>
    </article>
  `).join("");
}

function updateObservationCount() {
  const count = byId("observation-count");

  if (count) {
    count.textContent = String(state.observations.length);
  }
}

/* =========================================================
   11. VIEW AND EDIT AN OBSERVATION
   ========================================================= */

function findObservation(id) {
  return state.observations.find(
    (observation) => String(observation.id) === String(id)
  );
}

function viewObservation(id) {
  const observation = findObservation(id);

  if (!observation) {
    setMessage(
      "generated-note-message",
      "That observation could not be found. Refresh your saved records.",
      "error"
    );
    return;
  }

  const dialog = byId("observation-dialog");
  const title = byId("observation-dialog-title");
  const content = byId("observation-dialog-content");

  if (!dialog || !title || !content) return;

  title.textContent =
    observation.siteName ||
    observation.siteNumber ||
    "Observation details";

  content.innerHTML = `
    <div class="dialog-content">
      <p class="muted">
        ${escapeHTML(observation.siteNumber || "No site number")}
        · ${escapeHTML(formatDate(observation.date))}
      </p>

      <h3>Site details</h3>

      <p><strong>Location:</strong>
        ${escapeHTML(observation.siteName || "Not recorded")}</p>

      <p><strong>Time:</strong>
        ${escapeHTML(observation.time || "Not recorded")}</p>

      <p><strong>Coordinates:</strong>
        ${escapeHTML(
          observation.latitude || "Not recorded"
        )},
        ${escapeHTML(
          observation.longitude || "Not recorded"
        )}</p>

      <p><strong>Elevation:</strong>
        ${escapeHTML(
          observation.elevation === ""
            ? "Not recorded"
            : `${observation.elevation} m`
        )}</p>

      <p><strong>Environment:</strong>
        ${escapeHTML(observation.environment || "Not recorded")}</p>

      <hr class="divider">

      <h3>Original field notes</h3>
      <div class="note-output">
        ${escapeHTML(observation.rawNotes).replace(/\n/g, "<br>")}
      </div>

      <h3>Organized field notes</h3>
      <div class="note-output">
        ${escapeHTML(observation.organizedNotes).replace(/\n/g, "<br>")}
      </div>

      <p class="muted">
        Last updated:
        ${escapeHTML(formatDateTime(observation.updatedAt) || "Not available")}
      </p>

      <div class="form-actions">
        <button type="button"
                class="button button-primary"
                data-action="edit-observation"
                data-id="${escapeHTML(observation.id)}">
          Edit observation
        </button>

        <button type="button"
                class="button button-secondary"
                data-action="copy-observation"
                data-id="${escapeHTML(observation.id)}">
          Copy organized note
        </button>
      </div>
    </div>
  `;

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function editObservation(id) {
  const observation = findObservation(id);

  if (!observation) return;

  byId("observation-dialog")?.close();

  populateNotebookForm(observation);
}

async function copyObservation(id) {
  const observation = findObservation(id);

  if (!observation) return;

  try {
    await navigator.clipboard.writeText(
      observation.organizedNotes || observation.rawNotes || ""
    );

    const message = byId("generated-note-message");

    if (message) {
      setMessage(
        message,
        "Observation copied to your clipboard.",
        "success"
      );
    }
  } catch (error) {
    console.error("Clipboard error:", error);

    window.alert(
      "Your browser could not copy the note. Open the observation and copy its text manually."
    );
  }
}

/* =========================================================
   12. DELETE OBSERVATIONS WITH CONFIRMATION
   ========================================================= */

function requestDeleteObservation(id) {
  const observation = findObservation(id);

  if (!observation) return;

  state.pendingDeleteId = id;

  const dialog = byId("confirm-delete-dialog");

  if (dialog && typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    const confirmed = window.confirm(
      "Delete this observation? This action cannot be undone."
    );

    if (confirmed) {
      deleteObservation(id);
    }
  }
}

async function deleteObservation(id) {
  const button = byId("confirm-delete-button");

  if (button) {
    setButtonLoading(button, true, "Deleting...");
  }

  try {
    await apiRequest(
      `/observations/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );

    state.observations = state.observations.filter(
      (observation) => String(observation.id) !== String(id)
    );

    renderObservations();
    renderRecentObservations();
    updateObservationCount();

    byId("confirm-delete-dialog")?.close();
    byId("observation-dialog")?.close();

    state.pendingDeleteId = null;
  } catch (error) {
    window.alert(
      showError(error, "Unable to delete this observation.")
    );
  } finally {
    if (button) {
      setButtonLoading(button, false);
    }
  }
}

/* =========================================================
   13. OBSERVATION ACTION DISPATCHER
   ========================================================= */

document.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");

  if (!actionButton) return;

  const action = actionButton.dataset.action;
  const id = actionButton.dataset.id;

  switch (action) {
    case "view-observation":
      viewObservation(id);
      break;

    case "edit-observation":
      editObservation(id);
      break;

    case "delete-observation":
      requestDeleteObservation(id);
      break;

    case "copy-observation":
      await copyObservation(id);
      break;

    case "retry-observations":
      await loadObservations();
      break;

    default:
      break;
  }
});

byId("confirm-delete-button")?.addEventListener("click", (event) => {
  /*
  A dialog form with method="dialog" closes by default.
  Prevent that until the server confirms the deletion.
  */
  event.preventDefault();

  if (state.pendingDeleteId) {
    deleteObservation(state.pendingDeleteId);
  }
});

/* =========================================================
   14. SEARCH AND SORT
   ========================================================= */

function setupObservationSearch() {
  byId("observation-search")?.addEventListener("input", () => {
    renderObservations();
  });

  byId("observation-sort")?.addEventListener("change", () => {
    renderObservations();
  });

  byId("global-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    performGlobalSearch();
  });

  byId("global-search")?.addEventListener("input", () => {
    const query = byId("global-search").value.trim();

    if (query.length >= 2) {
      performGlobalSearch();
    }
  });

  document.addEventListener("keydown", (event) => {
    const isShortcut =
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "k";

    if (!isShortcut) return;

    event.preventDefault();

    const search = byId("global-search");

    if (search && !byId("main-app").hidden) {
      search.focus();
    }
  });
}

function performGlobalSearch() {
  const query = byId("global-search").value.trim();

  if (!query) return;

  const obsSearch = byId("observation-search");
  if (obsSearch) {
    obsSearch.value = query;
  }

  navigateTo("observations");
  renderObservations();
}

/* =========================================================
   15. PROFILE SETTINGS
   ========================================================= */

async function handleProfileSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);

  const fullName = byId("profile-name").value.trim();

  setMessage("profile-message", "");

  if (!fullName) {
    setMessage(
      "profile-message",
      "Your name cannot be empty.",
      "error"
    );
    return;
  }

  setButtonLoading(button, true, "Saving profile...");

  try {
    const result = await apiRequest(
      "/profile",
      jsonRequest("PUT", { fullName })
    );

    const user =
      result?.user ||
      result?.profile ||
      {
        ...state.user,
        fullName
      };

    state.user = {
      ...state.user,
      ...user,
      fullName
    };

    const displayName = state.user.fullName || fullName;

    if (hasElement("header-user-name")) {
      byId("header-user-name").textContent = displayName;
    }

    if (hasElement("welcome-name")) {
      byId("welcome-name").textContent = displayName.split(" ")[0];
    }

    if (hasElement("user-avatar")) {
      byId("user-avatar").textContent = getInitials(displayName);
    }

    setMessage(
      "profile-message",
      "Profile updated successfully.",
      "success"
    );
  } catch (error) {
    setMessage(
      "profile-message",
      showError(error, "Unable to update your profile."),
      "error"
    );
  } finally {
    setButtonLoading(button, false);
  }
}

/* =========================================================
   16. GUIDE SEARCH PLACEHOLDERS
   ========================================================= */

function setupGuideSearch() {
  byId("rock-guide-search")?.addEventListener("input", (event) => {
    const query = event.target.value.trim();

    /*
    When a reviewed rock catalogue is connected, filter its entries here.
    The current HTML contains a placeholder rather than catalogue data.
    */
    console.info("Rock guide search:", query);
  });

  byId("mineral-guide-search")?.addEventListener("input", (event) => {
    const query = event.target.value.trim();

    console.info("Mineral guide search:", query);
  });
}

/* =========================================================
   17. COPYRIGHT YEAR
   ========================================================= */

function updateCopyrightYear() {
  const year = new Date().getFullYear();

  if (hasElement("copyright-year")) {
    byId("copyright-year").textContent = String(year);
  }

  $$(".footer-year").forEach((element) => {
    element.textContent = String(year);
  });
}

/* =========================================================
   18. NETWORK STATUS
   ========================================================= */

function setupNetworkMessages() {
  window.addEventListener("offline", () => {
    console.warn("GeoGuide is offline.");

    const message = byId("generated-note-message");

    if (message) {
      setMessage(
        message,
        "You are offline. Keep your draft open; cloud saving and AI services require a connection.",
        "warning"
      );
    }
  });

  window.addEventListener("online", () => {
    console.info("Internet connection restored.");

    if (state.user) {
      loadObservations();
    }
  });
}

/* =========================================================
   19. INITIALIZE APPLICATION
   ========================================================= */

function initializeGeoGuide() {
  /* Authentication */
  byId("signin-form")?.addEventListener(
    "submit",
    handleSignIn
  );

  byId("signup-form")?.addEventListener(
    "submit",
    handleSignUp
  );

  byId("forgot-password-form")?.addEventListener(
    "submit",
    handleForgotPassword
  );

  byId("signout-button")?.addEventListener(
    "click",
    handleSignOut
  );

  setupPasswordToggles();

  /* Navigation */
  setupNavigation();

  /* Rock identifier */
  setupConditionalRockFields();

  byId("rock-identifier-form")?.addEventListener(
    "submit",
    handleRockIdentification
  );

  /* Field notebook */
  byId("field-notebook-form")?.addEventListener(
    "submit",
    handleNotebookSubmit
  );

  byId("clear-notebook-form")?.addEventListener(
    "click",
    clearNotebookForm
  );

  byId("regenerate-note")?.addEventListener(
    "click",
    regenerateNotes
  );

  byId("save-observation")?.addEventListener(
    "click",
    saveObservation
  );

  /* Observations */
  setupObservationSearch();

  /* Profile and guides */
  byId("profile-form")?.addEventListener(
    "submit",
    handleProfileSubmit
  );

  initGeoGuideFieldTools();

  /* Other interface details */
  updateCopyrightYear();
  setupNetworkMessages();

  /*
  Begin with the sign-in screen.
  Check the server for a valid session rather than assuming the user
  is logged in.
  */
  checkExistingSession();
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeGeoGuide
  );
} else {
  initializeGeoGuide();
}


/* ==========================================
   GEOGUIDE FIELD TOOLS CALCULATORS
   ========================================== */

function initGeoGuideFieldTools() {
    const get = (id) => document.getElementById(id);

    const paceButton = get("calculate-pace");
    const strikeButton = get("format-strike-dip");
    const convertButton = get("convert-distance");

    if (paceButton && !paceButton.dataset.initialized) {
        paceButton.dataset.initialized = "true";

        paceButton.addEventListener("click", () => {
            const paces = Number(get("pace-count").value);
            const factor = Number(get("pace-factor").value);
            const output = get("pace-result");

            if (
                get("pace-count").value.trim() === "" ||
                get("pace-factor").value.trim() === "" ||
                !Number.isFinite(paces) ||
                !Number.isFinite(factor) ||
                paces < 0 ||
                factor <= 0
            ) {
                output.textContent =
                    "Enter a valid pace count and a positive pace factor.";
                return;
            }

            const metres = paces * factor;

            output.textContent = metres >= 1000
                ? `${metres.toLocaleString(undefined, {
                    maximumFractionDigits: 2
                  })} m (${(metres / 1000).toLocaleString(undefined, {
                    maximumFractionDigits: 3
                  })} km)`
                : `${metres.toLocaleString(undefined, {
                    maximumFractionDigits: 2
                  })} m`;
        });
    }

    if (strikeButton && !strikeButton.dataset.initialized) {
        strikeButton.dataset.initialized = "true";

        strikeButton.addEventListener("click", () => {
            const strikeInput = get("strike-value").value.trim();
            const dipInput = get("dip-angle").value.trim();
            const direction = get("dip-direction").value;
            const output = get("strike-dip-result");

            const strike = Number(strikeInput);
            const dip = Number(dipInput);

            if (
                strikeInput === "" ||
                dipInput === "" ||
                !Number.isFinite(strike) ||
                !Number.isFinite(dip) ||
                strike < 0 ||
                strike > 359 ||
                dip < 0 ||
                dip > 90 ||
                !direction
            ) {
                output.textContent =
                    "Enter a strike from 0–359°, dip from 0–90°, and a dip direction.";
                return;
            }

            output.textContent =
                `Strike ${strike}° / Dip ${dip}° ${direction}`;
        });
    }

    if (convertButton && !convertButton.dataset.initialized) {
        convertButton.dataset.initialized = "true";

        convertButton.addEventListener("click", () => {
            const raw = get("distance-value").value.trim();
            const unit = get("distance-unit").value;
            const output = get("distance-result");

            const value = Number(raw);

            if (
                raw === "" ||
                !Number.isFinite(value) ||
                value < 0
            ) {
                output.textContent = "Enter a valid non-negative distance.";
                return;
            }

            let metres;

            if (unit === "km") metres = value * 1000;
            else if (unit === "cm") metres = value / 100;
            else metres = value;

            const format = (number) =>
                number.toLocaleString(undefined, {
                    maximumFractionDigits: 4
                });

            output.innerHTML = [
                `${format(metres)} m — metres`,
                `${format(metres / 1000)} km — kilometres`,
                `${format(metres * 100)} cm — centimetres`
            ].join("<br>");
        });
    }
}

initGeoGuideFieldTools();
