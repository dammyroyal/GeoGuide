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

function resolveApiBaseUrl() {
  if (typeof window !== "undefined" && window.GEOGUIDE_API_URL) {
    return window.GEOGUIDE_API_URL;
  }
  try {
    const saved = localStorage.getItem("geoguide_api_base");
    if (saved && saved.trim()) return saved.trim();
  } catch (_) {}

  // If testing on localhost, use local backend
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return "http://localhost:5000/api";
  }

  // Deployed production backend (e.g., Render, Railway, or Netlify proxy)
  return "https://geoguide-backend.onrender.com/api";
}

let API_BASE = resolveApiBaseUrl();

// Helper to allow runtime API host switching if needed
window.setGeoGuideBackend = function(url) {
  if (url) {
    localStorage.setItem("geoguide_api_base", url);
    API_BASE = url;
    console.log("[GeoGuide] API URL updated to:", url);
  }
};

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

  if (viewName === "dashboard") {
    renderTermOfTheDay();
  }

  if (viewName === "map") {
    initGeoGuideMap();
  }

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
    projectName: byId("project-name") ? byId("project-name").value.trim() : "",
    siteNumber: byId("site-number").value.trim(),
    siteName: byId("site-name").value.trim(),
    observerName: byId("observer-name") ? byId("observer-name").value.trim() : "",
    date: byId("site-date").value,
    time: byId("site-time").value,
    latitude: byId("site-latitude").value.trim(),
    longitude: byId("site-longitude").value.trim(),
    elevation: byId("site-elevation").value,
    coordinateRef: byId("coord-ref") ? byId("coord-ref").value.trim() : "",
    environment: byId("site-environment").value.trim(),
    lithology: byId("obs-lithology") ? byId("obs-lithology").value.trim() : "",
    color: byId("obs-color") ? byId("obs-color").value.trim() : "",
    grainSize: byId("obs-grain-size") ? byId("obs-grain-size").value.trim() : "",
    texture: byId("obs-texture") ? byId("obs-texture").value.trim() : "",
    mineralComposition: byId("obs-minerals") ? byId("obs-minerals").value.trim() : "",
    structures: byId("obs-structures") ? byId("obs-structures").value.trim() : "",
    orientations: byId("obs-orientations") ? byId("obs-orientations").value.trim() : "",
    contacts: byId("obs-contacts") ? byId("obs-contacts").value.trim() : "",
    weathering: byId("obs-weathering") ? byId("obs-weathering").value.trim() : "",
    fieldRelationships: byId("obs-field-relationships") ? byId("obs-field-relationships").value.trim() : "",
    sampleNumber: byId("obs-sample-number") ? byId("obs-sample-number").value.trim() : "",
    photoRef: byId("obs-photo-ref") ? byId("obs-photo-ref").value.trim() : "",
    rawNotes: byId("raw-observations").value.trim(),
    additionalNotes: byId("obs-additional-notes") ? byId("obs-additional-notes").value.trim() : "",
    interpretation: byId("obs-interpretation") ? byId("obs-interpretation").value.trim() : ""
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

function formatGeologicalFieldReport(input) {
  const getVal = (v, fallback = "Not recorded") => (v && String(v).trim()) ? String(v).trim() : fallback;

  let latStr = "Not recorded";
  let lngStr = "Not recorded";
  if (input.latitude && !Number.isNaN(Number(input.latitude))) {
    const latNum = Number(input.latitude);
    latStr = `${Math.abs(latNum).toFixed(6)}° ${latNum >= 0 ? "N" : "S"}`;
  }
  if (input.longitude && !Number.isNaN(Number(input.longitude))) {
    const lngNum = Number(input.longitude);
    lngStr = `${Math.abs(lngNum).toFixed(6)}° ${lngNum >= 0 ? "E" : "W"}`;
  }

  const sections = [
    `================================================================================`,
    `                   GEOLOGICAL FIELD OBSERVATION RECORD`,
    `================================================================================`,
    "",
    `1. SITE IDENTIFICATION`,
    `--------------------------------------------------------------------------------`,
    `Project / Field Trip : ${getVal(input.projectName)}`,
    `Observation / Site   : ${getVal(input.siteNumber)}`,
    `Site / Locality Name : ${getVal(input.siteName)}`,
    `Observer Name        : ${getVal(input.observerName)}`,
    "",
    `2. DATE AND TIME`,
    `--------------------------------------------------------------------------------`,
    `Date                 : ${input.date ? formatDate(input.date) : "Not recorded"}`,
    `Time                 : ${getVal(input.time)}`,
    "",
    `3. COORDINATES AND ELEVATION`,
    `--------------------------------------------------------------------------------`,
    `Latitude             : ${latStr}`,
    `Longitude            : ${lngStr}`,
    `Estimated Elevation  : ${input.elevation ? `${input.elevation} m a.s.l.` : "Not recorded"}`,
    `Coordinate Datum     : ${getVal(input.coordinateRef, "WGS 84 (assumed)")}`,
    "",
    `4. GEOLOGICAL SETTING`,
    `--------------------------------------------------------------------------------`,
    `Environment / Setting: ${getVal(input.environment)}`,
    "",
    `5. LITHOLOGY AND MATERIAL DESCRIPTION`,
    `--------------------------------------------------------------------------------`,
    `Rock / Sediment Type : ${getVal(input.lithology)}`,
    `Colour (Fresh/Weath.): ${getVal(input.color)}`,
    `Grain Size           : ${getVal(input.grainSize)}`,
    `Texture & Fabric     : ${getVal(input.texture)}`,
    `Mineral Composition  : ${getVal(input.mineralComposition)}`,
    "",
    `6. OBSERVABLE TEXTURES AND STRUCTURES`,
    `--------------------------------------------------------------------------------`,
    `Primary/Sec. Struct. : ${getVal(input.structures)}`,
    `Bedding / Foliation  : ${getVal(input.orientations)}`,
    `Weathering & Alter.  : ${getVal(input.weathering)}`,
    "",
    `7. FIELD RELATIONSHIPS & CONTACTS`,
    `--------------------------------------------------------------------------------`,
    `Contacts & Bounds    : ${getVal(input.contacts)}`,
    `Surrounding Geology  : ${getVal(input.fieldRelationships)}`,
    "",
    `8. SAMPLE AND PHOTOGRAPH REFERENCES`,
    `--------------------------------------------------------------------------------`,
    `Sample Number(s)     : ${getVal(input.sampleNumber, "None collected")}`,
    `Photographic Ref.    : ${getVal(input.photoRef, "None recorded")}`,
    ""
  ];

  let obsIdx = 9;
  if (input.interpretation && input.interpretation.trim()) {
    sections.push(
      `9. GEOLOGICAL INTERPRETATION (STUDENT WORKING HYPOTHESIS)`,
      `--------------------------------------------------------------------------------`,
      input.interpretation.trim(),
      ""
    );
    obsIdx = 10;
  }

  sections.push(
    `${obsIdx}. ADDITIONAL OBSERVATIONS & RAW FIELD NOTES`,
    `--------------------------------------------------------------------------------`,
    input.rawNotes.trim()
  );

  if (input.additionalNotes && input.additionalNotes.trim()) {
    sections.push(
      "",
      `Field Notes:`,
      input.additionalNotes.trim()
    );
  }

  sections.push(
    "",
    `================================================================================`,
    `Documented with GeoGuide Field Notebook (Deterministic Browser Generator)`,
    `================================================================================`
  );

  return sections.join("\n");
}

function generateOrganizedNotes() {
  const input = getNotebookInput();
  const validationError = validateNotebookInput(input);

  if (validationError) {
    setMessage("notebook-message", validationError, "error");
    return;
  }

  setMessage("notebook-message", "");

  const organizedText = formatGeologicalFieldReport(input);

  state.currentDraft = {
    ...input,
    organizedNotes: organizedText,
    observationId: byId("observation-id").value || null
  };

  byId("generated-note").value = organizedText;
  showGeneratedNotePanel();

  setMessage(
    "notebook-message",
    "Field notes structured successfully in your browser.",
    "success"
  );

  setMessage(
    "generated-note-message",
    "Structured note generated. You can edit the text directly before saving.",
    "info"
  );

  byId("generated-note-panel").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
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

function regenerateNotes() {
  const confirmed = window.confirm(
    "Generate a fresh draft from current form inputs? Any manual edits made inside the textarea will be refreshed."
  );

  if (!confirmed) return;

  generateOrganizedNotes();
}

function populateNotebookForm(observation) {
  const mapping = {
    "observation-id": observation.id,
    "project-name": observation.projectName || "",
    "site-number": observation.siteNumber || observation.site_number || "",
    "site-name": observation.siteName || observation.site_name || "",
    "observer-name": observation.observerName || "",
    "site-date": observation.date || observation.observation_date || "",
    "site-time": observation.time || "",
    "site-latitude": observation.latitude || "",
    "site-longitude": observation.longitude || "",
    "site-elevation": observation.elevation || "",
    "coord-ref": observation.coordinateRef || "",
    "site-environment": observation.environment || "",
    "obs-lithology": observation.lithology || "",
    "obs-color": observation.color || "",
    "obs-grain-size": observation.grainSize || "",
    "obs-texture": observation.texture || "",
    "obs-minerals": observation.mineralComposition || "",
    "obs-structures": observation.structures || "",
    "obs-orientations": observation.orientations || "",
    "obs-contacts": observation.contacts || "",
    "obs-weathering": observation.weathering || "",
    "obs-field-relationships": observation.fieldRelationships || "",
    "obs-sample-number": observation.sampleNumber || "",
    "obs-photo-ref": observation.photoRef || "",
    "raw-observations": observation.rawNotes || observation.raw_notes || "",
    "obs-additional-notes": observation.additionalNotes || "",
    "obs-interpretation": observation.interpretation || "",
    "generated-note": observation.organizedNotes || observation.organized_notes || ""
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

/* =========================================================
   20. GEOLOGY TERM OF THE DAY (DASHBOARD)
   ========================================================= */

function renderTermOfTheDay() {
  const titleEl = byId("daily-term-title");
  const catEl = byId("daily-term-category");
  const defEl = byId("daily-term-definition");

  if (!titleEl || !catEl || !defEl) return;

  const terms = window.GEOLOGY_TERMS;
  if (!Array.isArray(terms) || terms.length === 0) {
    titleEl.textContent = "Porosity";
    catEl.textContent = "Petroleum Geology";
    defEl.textContent = "The percentage of a rock's total volume occupied by pores or void spaces. Porosity influences how much fluid a rock can store.";
    return;
  }

  const now = new Date();
  // Deterministic UTC calendar day calculation
  const dayNumber = Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / (1000 * 60 * 60 * 24)
  );
  const index = Math.abs(dayNumber) % terms.length;
  const item = terms[index];

  titleEl.textContent = item.term;
  catEl.textContent = item.category || "Geology";
  defEl.textContent = item.definition;
}


/* =========================================================
   21. GEOGUIDE MAP (LEAFLET & GPS FIELD COORDINATES)
   ========================================================= */

let mapInstance = null;
let mapMarker = null;
let gpsMarker = null;
let elevationCache = new Map();

function initGeoGuideMap() {
  const mapContainer = byId("geoguide-map");
  if (!mapContainer) return;

  // If Leaflet library is still loading from CDN, retry shortly
  if (typeof L === "undefined") {
    setTimeout(initGeoGuideMap, 200);
    return;
  }

  if (mapInstance) {
    setTimeout(() => {
      mapInstance.invalidateSize();
    }, 100);
    return;
  }

  // Initial view: Port Harcourt, Nigeria [4.8156, 7.0498]
  const defaultLat = 4.8156;
  const defaultLng = 7.0498;

  mapInstance = L.map("geoguide-map", {
    center: [defaultLat, defaultLng],
    zoom: 12,
    zoomControl: true
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(mapInstance);

  // Map click listener: select any geological outcrop location
  mapInstance.on("click", (event) => {
    const { lat, lng } = event.latlng;
    setMapPoint(lat, lng, "click");
  });

  // Find My Location button
  byId("btn-find-my-location")?.addEventListener("click", requestUserGeolocation);

  // Center Port Harcourt button
  byId("btn-center-portharcourt")?.addEventListener("click", () => {
    if (mapInstance) {
      mapInstance.setView([defaultLat, defaultLng], 12);
    }
  });

  // Copy coordinates button
  byId("btn-copy-coordinates")?.addEventListener("click", copyFieldCoordinates);

  // Send to Field Notebook button
  byId("btn-send-to-notebook")?.addEventListener("click", sendCoordinatesToNotebook);
}

function setMapPoint(lat, lng, source = "click") {
  if (!mapInstance) return;

  if (mapMarker) {
    mapMarker.setLatLng([lat, lng]);
  } else {
    mapMarker = L.marker([lat, lng], { draggable: true }).addTo(mapInstance);
    mapMarker.on("dragend", (e) => {
      const pos = e.target.getLatLng();
      setMapPoint(pos.lat, pos.lng, "click");
    });
  }

  const latFormatted = `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? "N" : "S"}`;
  const lngFormatted = `${Math.abs(lng).toFixed(6)}° ${lng >= 0 ? "E" : "W"}`;

  byId("display-latitude").textContent = latFormatted;
  byId("display-longitude").textContent = lngFormatted;
  byId("display-elevation").textContent = "Estimating terrain elevation...";

  const badge = byId("location-source-badge");
  if (badge) {
    if (source === "gps") {
      badge.textContent = "Device GPS Location";
      badge.classList.remove("is-manual");
    } else {
      badge.textContent = "Selected Map Point";
      badge.classList.add("is-manual");
    }
  }

  const statusText = byId("map-status-text");
  if (statusText) {
    statusText.textContent = `${latFormatted}, ${lngFormatted}`;
  }

  byId("btn-copy-coordinates").disabled = false;
  byId("btn-send-to-notebook").disabled = false;

  fetchTerrainElevation(lat, lng);
}

async function fetchTerrainElevation(lat, lng) {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (elevationCache.has(cacheKey)) {
    const cached = elevationCache.get(cacheKey);
    byId("display-elevation").textContent = `${cached} m (a.s.l.)`;
    return;
  }

  try {
    // Try Open-Meteo elevation API (free, global DTM, no key required)
    const directUrl = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    let elev = null;

    try {
      const res = await fetch(directUrl);
      if (res.ok) {
        const data = await res.json();
        elev = Array.isArray(data?.elevation) ? data.elevation[0] : data?.elevation;
      }
    } catch (_) {
      // Fallback to backend proxy
      try {
        const proxyRes = await apiRequest(`/elevation?lat=${lat}&lng=${lng}`);
        if (proxyRes && typeof proxyRes.elevation === "number") {
          elev = proxyRes.elevation;
        }
      } catch (err) {
        console.warn("[Elevation] Proxy also unavailable:", err.message);
      }
    }

    if (typeof elev === "number" && !Number.isNaN(elev)) {
      const rounded = Math.round(elev);
      elevationCache.set(cacheKey, rounded);
      byId("display-elevation").textContent = `${rounded} m (a.s.l.)`;
    } else {
      byId("display-elevation").textContent = "Elevation unavailable";
    }
  } catch (error) {
    console.warn("[Elevation fetch error]:", error);
    byId("display-elevation").textContent = "Elevation unavailable";
  }
}

function requestUserGeolocation() {
  const statusText = byId("map-status-text");
  if (!navigator.geolocation) {
    if (statusText) {
      statusText.textContent = "Geolocation is not supported by your browser.";
    }
    window.alert("Geolocation is not supported by this browser. You can click any point on the map to select coordinates.");
    return;
  }

  if (statusText) {
    statusText.textContent = "Acquiring GPS fix (please grant browser location permission)...";
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Math.round(pos.coords.accuracy);

      if (mapInstance) {
        mapInstance.setView([lat, lng], 15);
      }

      setMapPoint(lat, lng, "gps");

      if (statusText) {
        statusText.textContent = `GPS Location acquired (±${accuracy} m)`;
      }
    },
    (err) => {
      let msg = "Could not obtain GPS location.";
      if (err.code === err.PERMISSION_DENIED) {
        msg = "Location permission denied. Click any location on the map instead.";
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        msg = "Location position is currently unavailable.";
      } else if (err.code === err.TIMEOUT) {
        msg = "GPS location request timed out.";
      }
      if (statusText) {
        statusText.textContent = msg;
      }
      window.alert(msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

function copyFieldCoordinates() {
  const lat = byId("display-latitude").textContent;
  const lng = byId("display-longitude").textContent;
  const elev = byId("display-elevation").textContent;

  if (lat === "—" || lng === "—") return;

  const textToCopy = [
    `Latitude: ${lat}`,
    `Longitude: ${lng}`,
    `Estimated elevation: ${elev}`
  ].join("\n");

  navigator.clipboard.writeText(textToCopy).then(() => {
    const msg = byId("coord-copy-message");
    if (msg) {
      msg.textContent = "Coordinates copied to clipboard!";
      msg.classList.add("success-text");
      setTimeout(() => {
        msg.textContent = "";
      }, 3000);
    }
  }).catch(() => {
    window.prompt("Copy coordinates:", textToCopy);
  });
}

function sendCoordinatesToNotebook() {
  const latText = byId("display-latitude").textContent;
  const lngText = byId("display-longitude").textContent;
  const elevText = byId("display-elevation").textContent;

  // Extract raw decimal values
  const latMatch = latText.match(/([\d.]+)°\s*([NS])/);
  const lngMatch = lngText.match(/([\d.]+)°\s*([EW])/);
  const elevMatch = elevText.match(/(-?[\d.]+)\s*m/);

  if (latMatch) {
    const val = parseFloat(latMatch[1]) * (latMatch[2] === "S" ? -1 : 1);
    if (byId("site-latitude")) byId("site-latitude").value = val.toFixed(6);
  }
  if (lngMatch) {
    const val = parseFloat(lngMatch[1]) * (lngMatch[2] === "W" ? -1 : 1);
    if (byId("site-longitude")) byId("site-longitude").value = val.toFixed(6);
  }
  if (elevMatch) {
    if (byId("site-elevation")) byId("site-elevation").value = Math.round(parseFloat(elevMatch[1]));
  }

  navigateTo("field-notebook");
  setMessage("notebook-message", "Coordinates and elevation transferred from GeoGuide Map.", "success");
}


/* =========================================================
   22. FIELD TOOLS: THREE GEOLOGICAL CALCULATORS
   ========================================================= */

function initGeoGuideFieldTools() {
  const get = (id) => document.getElementById(id);

  // --- TOP CALCULATOR TAB SWITCHING ---
  const calcTabs = $$(".calc-main-tab");
  calcTabs.forEach((tab) => {
    if (tab.dataset.initialized) return;
    tab.dataset.initialized = "true";

    tab.addEventListener("click", () => {
      const group = tab.dataset.calcGroup;
      calcTabs.forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle("is-active", isActive);
        t.setAttribute("aria-selected", isActive ? "true" : "false");
      });

      $$(".calc-container-panel").forEach((panel) => {
        const isMatch = panel.id === `panel-calc-${group}`;
        panel.classList.toggle("is-active", isMatch);
        panel.hidden = !isMatch;
      });
    });
  });

  // --- SUBTABS: MAP SCALE VS COORDINATE CONVERTER ---
  const subtabs = $$(".calc-subtab");
  subtabs.forEach((st) => {
    if (st.dataset.initialized) return;
    st.dataset.initialized = "true";

    st.addEventListener("click", () => {
      const targetSub = st.dataset.subpanel;
      subtabs.forEach((s) => s.classList.toggle("is-active", s === st));

      $$(".calc-subpanel").forEach((sp) => {
        const isMatch = sp.id === `subpanel-${targetSub}`;
        sp.classList.toggle("is-active", isMatch);
        sp.hidden = !isMatch;
      });
    });
  });

  // Mode Selectors
  setupCalcModeSelect("ms-mode-select", "ms-mode-");
  setupCalcModeSelect("cc-mode-select", "cc-mode-");
  setupCalcModeSelect("tr-mode-select", "tr-mode-");
  setupCalcModeSelect("st-mode-select", "st-mode-");

  // Structural C1: Compass vs Azimuth toggle
  const dipTypeSelect = get("st-c1-dip-type");
  if (dipTypeSelect && !dipTypeSelect.dataset.initialized) {
    dipTypeSelect.dataset.initialized = "true";
    dipTypeSelect.addEventListener("change", () => {
      const isAzimuth = dipTypeSelect.value === "azimuth";
      get("st-c1-compass-wrap").hidden = isAzimuth;
      get("st-c1-azimuth-wrap").hidden = !isAzimuth;
    });
  }

  // Unit conversion helpers (all to metres)
  const toMetres = {
    mm: 0.001,
    cm: 0.01,
    m: 1.0,
    km: 1000.0,
    in: 0.0254,
    ft: 0.3048
  };

  const fmtNum = (n, maxDec = 4) =>
    Number(n).toLocaleString(undefined, { maximumFractionDigits: maxDec });

  // -------------------------------------------------------------
  // CALCULATOR A1: MAP SCALE
  // -------------------------------------------------------------

  // Mode 1: Map Distance -> Ground Distance
  get("btn-ms-m1-calc")?.addEventListener("click", () => {
    const distRaw = get("ms-m1-map-dist").value.trim();
    const mapUnit = get("ms-m1-map-unit").value;
    const scaleRaw = get("ms-m1-scale").value.trim();
    const outUnit = get("ms-m1-out-unit").value;
    const errBox = get("ms-m1-error");
    const resBox = get("ms-m1-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const mapDist = parseFloat(distRaw);
    const scale = parseFloat(scaleRaw);

    if (distRaw === "" || Number.isNaN(mapDist) || mapDist <= 0) {
      errBox.textContent = "Please enter a valid positive map distance.";
      errBox.hidden = false;
      return;
    }
    if (scaleRaw === "" || Number.isNaN(scale) || scale < 1) {
      errBox.textContent = "Please enter a valid scale denominator (e.g. 50000 for 1:50,000).";
      errBox.hidden = false;
      return;
    }

    const mapMetres = mapDist * toMetres[mapUnit];
    const groundMetres = mapMetres * scale;
    const groundKm = groundMetres / 1000;

    const mainVal = outUnit === "km"
      ? `${fmtNum(groundKm)} km`
      : `${fmtNum(groundMetres)} m`;

    get("ms-m1-val").textContent = mainVal;
    get("ms-m1-equiv").textContent =
      `Equivalent distance: ${fmtNum(groundMetres)} m (${fmtNum(groundKm)} km)`;
    get("ms-m1-expl").textContent =
      `Map distance of ${mapDist} ${mapUnit} converted to real-world scale (1:${fmtNum(scale, 0)}) yields ${fmtNum(groundMetres)} metres.`;

    resBox.hidden = false;
  });

  get("btn-ms-m1-reset")?.addEventListener("click", () => {
    get("ms-m1-map-dist").value = "";
    get("ms-m1-scale").value = "";
    get("ms-m1-error").hidden = true;
    get("ms-m1-results").hidden = true;
  });

  // Mode 2: Ground Distance -> Map Distance
  get("btn-ms-m2-calc")?.addEventListener("click", () => {
    const distRaw = get("ms-m2-ground-dist").value.trim();
    const groundUnit = get("ms-m2-ground-unit").value;
    const scaleRaw = get("ms-m2-scale").value.trim();
    const mapUnit = get("ms-m2-map-unit").value;
    const errBox = get("ms-m2-error");
    const resBox = get("ms-m2-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const groundDist = parseFloat(distRaw);
    const scale = parseFloat(scaleRaw);

    if (distRaw === "" || Number.isNaN(groundDist) || groundDist <= 0) {
      errBox.textContent = "Please enter a valid positive ground distance.";
      errBox.hidden = false;
      return;
    }
    if (scaleRaw === "" || Number.isNaN(scale) || scale < 1) {
      errBox.textContent = "Please enter a valid scale denominator (e.g. 25000 for 1:25,000).";
      errBox.hidden = false;
      return;
    }

    const groundMetres = groundDist * toMetres[groundUnit];
    const mapMetres = groundMetres / scale;
    const mapVal = mapMetres / toMetres[mapUnit];

    get("ms-m2-val").textContent = `${fmtNum(mapVal)} ${mapUnit}`;
    get("ms-m2-expl").textContent =
      `A real-world ground distance of ${groundDist} ${groundUnit} drawn at 1:${fmtNum(scale, 0)} scale measures ${fmtNum(mapVal)} ${mapUnit} on the map.`;

    resBox.hidden = false;
  });

  get("btn-ms-m2-reset")?.addEventListener("click", () => {
    get("ms-m2-ground-dist").value = "";
    get("ms-m2-scale").value = "";
    get("ms-m2-error").hidden = true;
    get("ms-m2-results").hidden = true;
  });

  // Mode 3: Calculate Map Scale (RF)
  get("btn-ms-m3-calc")?.addEventListener("click", () => {
    const mapRaw = get("ms-m3-map-dist").value.trim();
    const mapUnit = get("ms-m3-map-unit").value;
    const groundRaw = get("ms-m3-ground-dist").value.trim();
    const groundUnit = get("ms-m3-ground-unit").value;
    const errBox = get("ms-m3-error");
    const resBox = get("ms-m3-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const mapDist = parseFloat(mapRaw);
    const groundDist = parseFloat(groundRaw);

    if (mapRaw === "" || Number.isNaN(mapDist) || mapDist <= 0) {
      errBox.textContent = "Please enter a valid positive measured map distance.";
      errBox.hidden = false;
      return;
    }
    if (groundRaw === "" || Number.isNaN(groundDist) || groundDist <= 0) {
      errBox.textContent = "Please enter a valid positive ground distance.";
      errBox.hidden = false;
      return;
    }

    const mapMetres = mapDist * toMetres[mapUnit];
    const groundMetres = groundDist * toMetres[groundUnit];
    const denom = groundMetres / mapMetres;

    if (!Number.isFinite(denom) || denom < 1) {
      errBox.textContent = "Map distance cannot be greater than real-world ground distance.";
      errBox.hidden = false;
      return;
    }

    const roundedDenom = Math.round(denom);
    get("ms-m3-val").textContent = `1 : ${roundedDenom.toLocaleString()}`;
    get("ms-m3-denom").textContent = `Scale denominator: ${roundedDenom.toLocaleString()}`;
    get("ms-m3-expl").textContent =
      `Both distances were converted to common units (metres). 1 unit on this map represents ${roundedDenom.toLocaleString()} units on the ground.`;

    resBox.hidden = false;
  });

  get("btn-ms-m3-reset")?.addEventListener("click", () => {
    get("ms-m3-map-dist").value = "";
    get("ms-m3-ground-dist").value = "";
    get("ms-m3-error").hidden = true;
    get("ms-m3-results").hidden = true;
  });

  // -------------------------------------------------------------
  // CALCULATOR A2: COORDINATE CONVERTER
  // -------------------------------------------------------------

  // Mode 1: DMS -> Decimal Degrees
  get("btn-cc-m1-calc")?.addEventListener("click", () => {
    const degRaw = get("cc-m1-deg").value.trim();
    const minRaw = get("cc-m1-min").value.trim();
    const secRaw = get("cc-m1-sec").value.trim();
    const hemi = get("cc-m1-hemi").value;
    const errBox = get("cc-m1-error");
    const resBox = get("cc-m1-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const deg = parseFloat(degRaw);
    const min = parseFloat(minRaw || "0");
    const sec = parseFloat(secRaw || "0");

    if (degRaw === "" || Number.isNaN(deg) || deg < 0) {
      errBox.textContent = "Degrees must be a non-negative number.";
      errBox.hidden = false;
      return;
    }
    if (Number.isNaN(min) || min < 0 || min >= 60) {
      errBox.textContent = "Minutes must be between 0 and 59.999.";
      errBox.hidden = false;
      return;
    }
    if (Number.isNaN(sec) || sec < 0 || sec >= 60) {
      errBox.textContent = "Seconds must be between 0 and 59.999.";
      errBox.hidden = false;
      return;
    }

    const totalDeg = deg + (min / 60) + (sec / 3600);
    const isLatitude = hemi === "N" || hemi === "S";

    if (isLatitude && totalDeg > 90) {
      errBox.textContent = "Latitude cannot exceed 90 degrees.";
      errBox.hidden = false;
      return;
    }
    if (!isLatitude && totalDeg > 180) {
      errBox.textContent = "Longitude cannot exceed 180 degrees.";
      errBox.hidden = false;
      return;
    }

    const signedDeg = (hemi === "S" || hemi === "W") ? -totalDeg : totalDeg;

    get("cc-m1-axis-label").textContent = isLatitude
      ? `Decimal Latitude (${hemi})`
      : `Decimal Longitude (${hemi})`;
    get("cc-m1-val").textContent = `${signedDeg.toFixed(6)}°`;
    get("cc-m1-sign-note").textContent =
      `Formatted for GIS/mapping: ${signedDeg >= 0 ? "+" : ""}${signedDeg.toFixed(6)}`;

    resBox.hidden = false;
  });

  get("btn-cc-m1-reset")?.addEventListener("click", () => {
    get("cc-m1-deg").value = "";
    get("cc-m1-min").value = "";
    get("cc-m1-sec").value = "";
    get("cc-m1-error").hidden = true;
    get("cc-m1-results").hidden = true;
  });

  // Mode 2: Decimal Degrees -> DMS
  get("btn-cc-m2-calc")?.addEventListener("click", () => {
    const latRaw = get("cc-m2-lat").value.trim();
    const lngRaw = get("cc-m2-lng").value.trim();
    const errBox = get("cc-m2-error");
    const resBox = get("cc-m2-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const lat = parseFloat(latRaw);
    const lng = parseFloat(lngRaw);

    if (latRaw === "" || Number.isNaN(lat) || lat < -90 || lat > 90) {
      errBox.textContent = "Latitude must be between -90 and +90 degrees.";
      errBox.hidden = false;
      return;
    }
    if (lngRaw === "" || Number.isNaN(lng) || lng < -180 || lng > 180) {
      errBox.textContent = "Longitude must be between -180 and +180 degrees.";
      errBox.hidden = false;
      return;
    }

    function toDMS(val, posHemi, negHemi) {
      const hemi = val >= 0 ? posHemi : negHemi;
      let abs = Math.abs(val);
      let d = Math.floor(abs);
      let remM = (abs - d) * 60;
      let m = Math.floor(remM);
      let s = (remM - m) * 60;

      // Handle rounding carry
      if (s >= 59.995) {
        s = 0;
        m += 1;
        if (m >= 60) {
          m = 0;
          d += 1;
        }
      }

      const sStr = s.toFixed(2).padStart(5, "0");
      const mStr = String(m).padStart(2, "0");
      return `${d}° ${mStr}′ ${sStr}″ ${hemi}`;
    }

    get("cc-m2-lat-val").textContent = toDMS(lat, "N", "S");
    get("cc-m2-lng-val").textContent = toDMS(lng, "E", "W");

    resBox.hidden = false;
  });

  get("btn-cc-m2-reset")?.addEventListener("click", () => {
    get("cc-m2-lat").value = "";
    get("cc-m2-lng").value = "";
    get("cc-m2-error").hidden = true;
    get("cc-m2-results").hidden = true;
  });

  // -------------------------------------------------------------
  // CALCULATOR B: GEOLOGICAL TRAVERSE & ELEVATION
  // -------------------------------------------------------------

  // Mode B1: Slope Distance -> Horizontal Distance
  get("btn-tr-b1-calc")?.addEventListener("click", () => {
    const slopeRaw = get("tr-b1-slope-dist").value.trim();
    const unit = get("tr-b1-dist-unit").value;
    const angleRaw = get("tr-b1-angle").value.trim();
    const dir = get("tr-b1-dir").value;
    const errBox = get("tr-b1-error");
    const resBox = get("tr-b1-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const slopeDist = parseFloat(slopeRaw);
    const angle = parseFloat(angleRaw);

    if (slopeRaw === "" || Number.isNaN(slopeDist) || slopeDist <= 0) {
      errBox.textContent = "Please enter a valid positive slope distance.";
      errBox.hidden = false;
      return;
    }
    if (angleRaw === "" || Number.isNaN(angle) || angle < 0 || angle > 90) {
      errBox.textContent = "Slope angle must be between 0° and 90°.";
      errBox.hidden = false;
      return;
    }

    const rad = (angle * Math.PI) / 180;
    const horizDist = slopeDist * Math.cos(rad);
    const vertMag = slopeDist * Math.sin(rad);
    const signedVert = dir === "uphill" ? vertMag : -vertMag;

    get("tr-b1-horiz-val").textContent = `${fmtNum(horizDist, 2)} ${unit}`;
    get("tr-b1-vert-val").textContent = `${signedVert > 0 ? "+" : ""}${fmtNum(signedVert, 2)} ${unit}`;
    get("tr-b1-dir-label").textContent =
      `Vertical direction: ${dir.toUpperCase()} (${dir === "uphill" ? "Elevation gain" : "Elevation drop"})`;

    resBox.hidden = false;
  });

  get("btn-tr-b1-reset")?.addEventListener("click", () => {
    get("tr-b1-slope-dist").value = "";
    get("tr-b1-angle").value = "";
    get("tr-b1-error").hidden = true;
    get("tr-b1-results").hidden = true;
  });

  // Mode B2: Elevation Difference
  get("btn-tr-b2-calc")?.addEventListener("click", () => {
    const startRaw = get("tr-b2-start-elev").value.trim();
    const endRaw = get("tr-b2-end-elev").value.trim();
    const unit = get("tr-b2-unit").value;
    const errBox = get("tr-b2-error");
    const resBox = get("tr-b2-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const startElev = parseFloat(startRaw);
    const endElev = parseFloat(endRaw);

    if (startRaw === "" || Number.isNaN(startElev)) {
      errBox.textContent = "Please enter a valid starting elevation.";
      errBox.hidden = false;
      return;
    }
    if (endRaw === "" || Number.isNaN(endElev)) {
      errBox.textContent = "Please enter a valid ending elevation.";
      errBox.hidden = false;
      return;
    }

    const signedChange = endElev - startElev;
    const absDiff = Math.abs(signedChange);

    let status = "level";
    if (signedChange > 0) status = "uphill (endpoint is higher)";
    else if (signedChange < 0) status = "downhill (endpoint is lower)";
    else status = "level (same elevation)";

    get("tr-b2-signed-val").textContent = `${signedChange > 0 ? "+" : ""}${fmtNum(signedChange, 2)} ${unit}`;
    get("tr-b2-abs-val").textContent = `${fmtNum(absDiff, 2)} ${unit}`;
    get("tr-b2-status").textContent = `Traverse direction: ${status}`;
    get("tr-b2-expl").textContent =
      `From ${startElev} ${unit} to ${endElev} ${unit} results in a ${signedChange >= 0 ? "gain" : "loss"} of ${fmtNum(absDiff, 2)} ${unit}.`;

    resBox.hidden = false;
  });

  get("btn-tr-b2-reset")?.addEventListener("click", () => {
    get("tr-b2-start-elev").value = "";
    get("tr-b2-end-elev").value = "";
    get("tr-b2-error").hidden = true;
    get("tr-b2-results").hidden = true;
  });

  // Mode B3: Slope Gradient & Angle
  get("btn-tr-b3-calc")?.addEventListener("click", () => {
    const horizRaw = get("tr-b3-horiz-dist").value.trim();
    const horizUnit = get("tr-b3-horiz-unit").value;
    const vertRaw = get("tr-b3-vert-diff").value.trim();
    const vertUnit = get("tr-b3-vert-unit").value;
    const errBox = get("tr-b3-error");
    const resBox = get("tr-b3-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const horizDist = parseFloat(horizRaw);
    const vertDiff = parseFloat(vertRaw);

    if (horizRaw === "" || Number.isNaN(horizDist) || horizDist < 0) {
      errBox.textContent = "Please enter a non-negative horizontal distance.";
      errBox.hidden = false;
      return;
    }
    if (vertRaw === "" || Number.isNaN(vertDiff) || vertDiff < 0) {
      errBox.textContent = "Please enter a non-negative vertical elevation difference.";
      errBox.hidden = false;
      return;
    }

    const hM = horizDist * toMetres[horizUnit];
    const vM = vertDiff * toMetres[vertUnit];

    if (hM === 0 && vM === 0) {
      get("tr-b3-angle-val").textContent = "0.00°";
      get("tr-b3-pct-val").textContent = "0.00%";
      get("tr-b3-ratio-val").textContent = "Level (horizontal)";
      get("tr-b3-expl").textContent = "Level horizontal surface: zero elevation change over distance.";
      resBox.hidden = false;
      return;
    }

    if (hM === 0 && vM > 0) {
      get("tr-b3-angle-val").textContent = "90.00°";
      get("tr-b3-pct-val").textContent = "Undefined (Vertical cliff)";
      get("tr-b3-ratio-val").textContent = "1 : 0 (Vertical face)";
      get("tr-b3-expl").textContent = "A vertical wall or cliff: slope angle is 90°; gradient percentage and ratio cannot be calculated normally due to zero horizontal run.";
      resBox.hidden = false;
      return;
    }

    if (vM === 0 && hM > 0) {
      get("tr-b3-angle-val").textContent = "0.00°";
      get("tr-b3-pct-val").textContent = "0.00%";
      get("tr-b3-ratio-val").textContent = "Flat plane (1 : ∞)";
      get("tr-b3-expl").textContent = "Flat horizontal surface: vertical difference is zero, so slope angle and gradient are 0%.";
      resBox.hidden = false;
      return;
    }

    const slopeAngleRad = Math.atan(vM / hM);
    const slopeAngleDeg = (slopeAngleRad * 180) / Math.PI;
    const pct = (vM / hM) * 100;
    const ratioDenom = hM / vM;

    get("tr-b3-angle-val").textContent = `${fmtNum(slopeAngleDeg, 2)}°`;
    get("tr-b3-pct-val").textContent = `${fmtNum(pct, 2)}%`;
    get("tr-b3-ratio-val").textContent = `1 : ${fmtNum(ratioDenom, 2)}`;
    get("tr-b3-expl").textContent =
      `For every ${fmtNum(ratioDenom, 2)} units traveled horizontally, the slope rises or drops 1 unit vertically.`;

    resBox.hidden = false;
  });

  get("btn-tr-b3-reset")?.addEventListener("click", () => {
    get("tr-b3-horiz-dist").value = "";
    get("tr-b3-vert-diff").value = "";
    get("tr-b3-error").hidden = true;
    get("tr-b3-results").hidden = true;
  });

  // -------------------------------------------------------------
  // CALCULATOR C: STRUCTURAL GEOLOGY
  // -------------------------------------------------------------

  // Compass directions helper
  function compassToBearing(comp) {
    const bearings = {
      N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315
    };
    return bearings[comp.toUpperCase()] ?? 0;
  }

  function bearingToCompass16(az) {
    const norm = ((az % 360) + 360) % 360;
    const sectors = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const idx = Math.round(norm / 22.5) % 16;
    return sectors[idx];
  }

  function pad3(num) {
    return String(Math.round(num)).padStart(3, "0");
  }

  // Mode C1: Strike & Dip Notation Converter
  get("btn-st-c1-calc")?.addEventListener("click", () => {
    const strikeRaw = get("st-c1-strike").value.trim();
    const dipRaw = get("st-c1-dip").value.trim();
    const dipType = get("st-c1-dip-type").value;
    const errBox = get("st-c1-error");
    const warnBox = get("st-c1-warning");
    const resBox = get("st-c1-results");

    errBox.hidden = true;
    warnBox.hidden = true;
    resBox.hidden = true;

    const strike = parseFloat(strikeRaw);
    const dip = parseFloat(dipRaw);

    if (strikeRaw === "" || Number.isNaN(strike) || strike < 0 || strike > 360) {
      errBox.textContent = "Strike azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }
    if (dipRaw === "" || Number.isNaN(dip) || dip < 0 || dip > 90) {
      errBox.textContent = "Dip angle must be between 0° and 90°.";
      errBox.hidden = false;
      return;
    }

    let dipAzimuth = 0;
    let compassDir = "";

    if (dipType === "compass") {
      compassDir = get("st-c1-dip-compass").value;
      dipAzimuth = compassToBearing(compassDir);
    } else {
      const azRaw = get("st-c1-dip-azimuth").value.trim();
      const azVal = parseFloat(azRaw);
      if (azRaw === "" || Number.isNaN(azVal) || azVal < 0 || azVal > 360) {
        errBox.textContent = "Dip direction azimuth must be between 0° and 360°.";
        errBox.hidden = false;
        return;
      }
      dipAzimuth = azVal;
      compassDir = bearingToCompass16(dipAzimuth);
    }

    // Standardized strike format (000° to 359°)
    const normStrike = Math.round(strike) % 360;
    const formattedStrike = pad3(normStrike);

    // Validation & Right-Hand-Rule check
    // In RHR, dip direction = (strike + 90) % 360.
    // General planar geometry: dip direction is strictly perpendicular to strike (either strike+90 or strike-90).
    const rhrDipDir = (normStrike + 90) % 360;
    const altDipDir = (normStrike + 270) % 360;

    let rhrDiff = Math.abs(dipAzimuth - rhrDipDir);
    if (rhrDiff > 180) rhrDiff = 360 - rhrDiff;

    let altDiff = Math.abs(dipAzimuth - altDipDir);
    if (altDiff > 180) altDiff = 360 - altDiff;

    const minPerpDiff = Math.min(rhrDiff, altDiff);

    // Check horizontal and vertical planes
    if (dip === 0) {
      get("st-c1-notation").textContent = `Strike: Arbitrary / Dip: 00° (Horizontal Plane)`;
      get("st-c1-out-strike").textContent = `${formattedStrike}° (conventional)`;
      get("st-c1-out-dip").textContent = `0° (Horizontal)`;
      get("st-c1-out-dipdir").textContent = `Undefined (flat surface)`;
      get("st-c1-expl").textContent =
        "For a completely horizontal planar bed (dip 0°), strike and dip direction are arbitrary or conventional.";
      resBox.hidden = false;
      return;
    }

    if (dip === 90) {
      get("st-c1-notation").textContent = `Strike ${formattedStrike}° / Dip 90° (Vertical Plane)`;
      get("st-c1-out-strike").textContent = `${formattedStrike}°`;
      get("st-c1-out-dip").textContent = `90° (Vertical)`;
      get("st-c1-out-dipdir").textContent = `Vertical plane`;
      get("st-c1-expl").textContent =
        "For a vertical planar surface (dip 90°), the plane is upright along strike. Dip direction is conventional.";
      resBox.hidden = false;
      return;
    }

    // Normal inclined plane notation
    const standardNotation = `Strike ${formattedStrike}° / Dip ${Math.round(dip)}° ${compassDir}`;
    get("st-c1-notation").textContent = standardNotation;
    get("st-c1-out-strike").textContent = `${formattedStrike}°`;
    get("st-c1-out-dip").textContent = `${Math.round(dip)}°`;
    get("st-c1-out-dipdir").textContent = `${compassDir} (${pad3(dipAzimuth)}°)`;

    let expl = `Right-Hand Rule convention: Facing strike ${formattedStrike}°, the planar surface dips down to the right (${pad3(rhrDipDir)}°).`;

    if (minPerpDiff > 25) {
      warnBox.textContent =
        `Orientation warning: Strike (${formattedStrike}°) and dip direction (${pad3(dipAzimuth)}°) differ from strict 90° perpendicularity by ${Math.round(minPerpDiff)}°. Under Right-Hand Rule, strike ${formattedStrike}° implies dip direction ${pad3(rhrDipDir)}°. Please verify your field compass measurements.`;
      warnBox.hidden = false;
    } else {
      expl += ` Dip direction differs by 90° from strike as expected for planar bedding.`;
    }

    get("st-c1-expl").textContent = expl;
    resBox.hidden = false;
  });

  get("btn-st-c1-reset")?.addEventListener("click", () => {
    get("st-c1-strike").value = "";
    get("st-c1-dip").value = "";
    get("st-c1-error").hidden = true;
    get("st-c1-warning").hidden = true;
    get("st-c1-results").hidden = true;
  });

  // Mode C2: Apparent Dip Calculator
  get("btn-st-c2-calc")?.addEventListener("click", () => {
    const trueDipRaw = get("st-c2-true-dip").value.trim();
    const trueDipDirRaw = get("st-c2-dip-dir").value.trim();
    const measDirRaw = get("st-c2-meas-dir").value.trim();
    const errBox = get("st-c2-error");
    const resBox = get("st-c2-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const trueDip = parseFloat(trueDipRaw);
    const trueDipDir = parseFloat(trueDipDirRaw);
    const measDir = parseFloat(measDirRaw);

    if (trueDipRaw === "" || Number.isNaN(trueDip) || trueDip < 0 || trueDip > 90) {
      errBox.textContent = "True dip must be between 0° and 90°.";
      errBox.hidden = false;
      return;
    }
    if (trueDipDirRaw === "" || Number.isNaN(trueDipDir) || trueDipDir < 0 || trueDipDir > 360) {
      errBox.textContent = "True dip direction azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }
    if (measDirRaw === "" || Number.isNaN(measDir) || measDir < 0 || measDir > 360) {
      errBox.textContent = "Measurement direction azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }

    // Strike is perpendicular to true dip direction
    const strike = (trueDipDir + 90) % 360;
    const diffDeg = Math.abs(measDir - strike);
    const diffRad = (diffDeg * Math.PI) / 180;

    const trueDipRad = (trueDip * Math.PI) / 180;
    const tanApp = Math.tan(trueDipRad) * Math.abs(Math.sin(diffRad));
    const appDipRad = Math.atan(tanApp);
    const appDipDeg = (appDipRad * 180) / Math.PI;

    get("st-c2-app-dip").textContent = `${appDipDeg.toFixed(2)}°`;
    get("st-c2-true-comp").textContent = `${trueDip.toFixed(2)}°`;

    let expl = `With true dip ${trueDip}° and strike ${pad3(strike)}°: tan(apparent dip) = tan(${trueDip}°) × |sin(${measDir}° - ${pad3(strike)}°)| = ${tanApp.toFixed(4)}.`;
    const angleFromTrueDip = Math.abs(((measDir - trueDipDir + 180) % 360) - 180);
    if (angleFromTrueDip < 0.1) {
      expl += " Measurement direction matches true dip direction: apparent dip equals true dip.";
    } else if (Math.abs(angleFromTrueDip - 90) < 0.1) {
      expl += " Measurement direction is along strike: apparent dip is 0° (horizontal).";
    }

    get("st-c2-expl").textContent = expl;
    resBox.hidden = false;
  });

  get("btn-st-c2-reset")?.addEventListener("click", () => {
    get("st-c2-true-dip").value = "";
    get("st-c2-dip-dir").value = "";
    get("st-c2-meas-dir").value = "";
    get("st-c2-error").hidden = true;
    get("st-c2-results").hidden = true;
  });

  // Mode C3: Angular Difference Between Two Azimuths
  get("btn-st-c3-calc")?.addEventListener("click", () => {
    const az1Raw = get("st-c3-az1").value.trim();
    const az2Raw = get("st-c3-az2").value.trim();
    const mode = get("st-c3-mode").value;
    const errBox = get("st-c3-error");
    const resBox = get("st-c3-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const az1 = parseFloat(az1Raw);
    const az2 = parseFloat(az2Raw);

    if (az1Raw === "" || Number.isNaN(az1) || az1 < 0 || az1 > 360) {
      errBox.textContent = "First azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }
    if (az2Raw === "" || Number.isNaN(az2) || az2 < 0 || az2 > 360) {
      errBox.textContent = "Second azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }

    const cw = ((az2 - az1) % 360 + 360) % 360;
    const smallest = Math.min(cw, 360 - cw);

    if (mode === "smallest") {
      get("st-c3-diff").textContent = `${smallest.toFixed(2)}°`;
      let dirStr = "Identical azimuths (0°)";
      if (smallest > 0 && smallest < 180) {
        dirStr = cw <= 180 ? "Clockwise rotation" : "Counter-clockwise rotation";
      } else if (smallest === 180) {
        dirStr = "Opposite azimuths (180°)";
      }
      get("st-c3-dir").textContent = `Shortest rotation path: ${dirStr}`;
    } else {
      get("st-c3-diff").textContent = `${cw.toFixed(2)}°`;
      get("st-c3-dir").textContent = `Clockwise sweep from ${az1}° to ${az2}°`;
    }

    resBox.hidden = false;
  });

  get("btn-st-c3-reset")?.addEventListener("click", () => {
    get("st-c3-az1").value = "";
    get("st-c3-az2").value = "";
    get("st-c3-error").hidden = true;
    get("st-c3-results").hidden = true;
  });

  // Mode C4: Trend & Plunge Converter
  get("btn-st-c4-calc")?.addEventListener("click", () => {
    const trendRaw = get("st-c4-trend").value.trim();
    const plungeRaw = get("st-c4-plunge").value.trim();
    const errBox = get("st-c4-error");
    const resBox = get("st-c4-results");

    errBox.hidden = true;
    resBox.hidden = true;

    const trend = parseFloat(trendRaw);
    const plunge = parseFloat(plungeRaw);

    if (trendRaw === "" || Number.isNaN(trend) || trend < 0 || trend > 360) {
      errBox.textContent = "Trend azimuth must be between 0° and 360°.";
      errBox.hidden = false;
      return;
    }
    if (plungeRaw === "" || Number.isNaN(plunge) || plunge < 0 || plunge > 90) {
      errBox.textContent = "Plunge angle must be between 0° and 90°.";
      errBox.hidden = false;
      return;
    }

    const compass = bearingToCompass16(trend);
    const trendPad = pad3(trend % 360);
    const plungePad = Math.round(plunge);

    get("st-c4-notation").textContent = `${trendPad}°/${plungePad}°`;
    get("st-c4-trend-dir").textContent = `${compass} (${trendPad}°)`;
    get("st-c4-plunge-val").textContent = `${plungePad}° downward`;

    resBox.hidden = false;
  });

  get("btn-st-c4-reset")?.addEventListener("click", () => {
    get("st-c4-trend").value = "";
    get("st-c4-plunge").value = "";
    get("st-c4-error").hidden = true;
    get("st-c4-results").hidden = true;
  });
}

function setupCalcModeSelect(selectId, panelPrefix) {
  const select = document.getElementById(selectId);
  if (!select || select.dataset.initialized) return;
  select.dataset.initialized = "true";

  select.addEventListener("change", () => {
    const modeVal = select.value.replace(/^[a-z]/i, ""); // e.g. "m1" -> "1"
    const prefix = selectId.split("-")[0]; // "ms", "cc", "tr", "st"

    const panels = document.querySelectorAll(`[id^="${prefix}-mode-"]`);
    panels.forEach((p) => {
      const isMatch = p.id === `${prefix}-mode-${modeVal}`;
      p.classList.toggle("is-active", isMatch);
      p.hidden = !isMatch;
    });
  });
}

// Field notebook copy and download handlers
byId("btn-copy-note")?.addEventListener("click", () => {
  const noteText = byId("generated-note")?.value;
  if (!noteText || !noteText.trim()) return;
  navigator.clipboard.writeText(noteText).then(() => {
    setMessage("generated-note-message", "Field note copied to clipboard!", "success");
  }).catch(() => {
    window.prompt("Copy field note:", noteText);
  });
});

byId("btn-download-note")?.addEventListener("click", () => {
  const noteText = byId("generated-note")?.value;
  if (!noteText || !noteText.trim()) return;
  const siteNum = (byId("site-number")?.value || "observation").replace(/[^a-z0-9_-]/gi, "_");
  const blob = new Blob([noteText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${siteNum}_field_notes.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setMessage("generated-note-message", "Field note downloaded as text file.", "success");
});

// Run field tools initialization
initGeoGuideFieldTools();
renderTermOfTheDay();

