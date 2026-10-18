const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2mb" }));

// Prevent uncaught errors from crashing the backend process
process.on("uncaughtException", (err) => {
  console.error("[GeoGuide Backend] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[GeoGuide Backend] Unhandled Rejection:", reason);
});

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
} else {
  console.warn(
    "[GeoGuide Backend] Warning: Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in environment variables. Database & Auth routes will return 503."
  );
}

// Gemini configuration
const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey })
  : null;

// Multi-model fallback list to guarantee 100% uptime even during spikes or deprecations
const CANDIDATE_GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it"
];

async function generateWithGemini(prompt, options = {}) {
  if (!genAI) {
    throw new Error("Gemini API key is not configured in backend/.env");
  }

  let lastError = null;

  for (const model of CANDIDATE_GEMINI_MODELS) {
    try {
      const config = {};
      if (options.jsonMode) {
        config.responseMimeType = "application/json";
      }

      const response = await genAI.models.generateContent({
        model,
        contents: prompt,
        config
      });

      if (response && typeof response.text === "string") {
        return response.text;
      }
    } catch (err) {
      console.warn(`[Gemini Fallback] Model ${model} failed (${err.status || err.message}). Trying next...`);
      lastError = err;
    }
  }

  throw lastError || new Error("All candidate Gemini AI models were unavailable.");
}

// Data storage for observations: local persistent JSON store with automatic directory creation
const DATA_DIR = path.join(__dirname, "data");
const OBSERVATIONS_FILE = path.join(DATA_DIR, "observations.json");

function ensureDataStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(OBSERVATIONS_FILE)) {
    fs.writeFileSync(OBSERVATIONS_FILE, JSON.stringify([], null, 2), "utf8");
  }
}
ensureDataStorage();

function readLocalObservations() {
  try {
    ensureDataStorage();
    const raw = fs.readFileSync(OBSERVATIONS_FILE, "utf8");
    return JSON.parse(raw) || [];
  } catch (error) {
    console.error("[Storage] Error reading observations:", error.message);
    return [];
  }
}

function writeLocalObservations(list) {
  try {
    ensureDataStorage();
    fs.writeFileSync(OBSERVATIONS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (error) {
    console.error("[Storage] Error writing observations:", error.message);
  }
}

// Helpers
function getToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ")
    ? header.slice(7)
    : null;
}

async function getAuthenticatedUser(req) {
  const token = getToken(req);

  if (!token) {
    return { user: null, token: null, error: "Authentication required." };
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return { user: null, token, error: "Your session is invalid or expired." };
  }

  return { user: data.user, token, error: null };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.user_metadata?.username || "",
    fullName: user.user_metadata?.full_name || ""
  };
}

// Health check endpoints
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "GeoGuide backend is running!",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "geoguide-backend",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Elevation proxy endpoint (Open-Meteo terrain model)
app.get("/api/elevation", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        error: "Valid numeric latitude (lat) and longitude (lng) are required."
      });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        error: "Coordinates out of bounds (-90 to +90 lat, -180 to +180 lng)."
      });
    }

    const apiUrl = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error(`Elevation service returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const elevation = Array.isArray(data?.elevation) ? data.elevation[0] : data?.elevation;

    if (typeof elevation !== "number" || Number.isNaN(elevation)) {
      throw new Error("Invalid elevation payload returned by service.");
    }

    res.json({
      status: "success",
      latitude: lat,
      longitude: lng,
      elevation: Math.round(elevation),
      unit: "metres",
      source: "Open-Meteo Digital Terrain Model"
    });
  } catch (error) {
    console.warn("[Elevation API Error]:", error.message);
    res.status(502).json({
      error: "Elevation data currently unavailable for this location."
    });
  }
});

// Supabase connection test
app.use((req, res, next) => {
  if (
    (req.path.startsWith("/api/auth") ||
      req.path.startsWith("/api/profile") ||
      req.path.startsWith("/api/observations") ||
      req.path === "/api/supabase-test") &&
    !supabase
  ) {
    return res.status(503).json({
      status: "error",
      error:
        "Supabase database service is not configured on this server. Please check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY."
    });
  }
  next();
});

app.get("/api/supabase-test", async (req, res) => {
  try {
    const { error } = await supabase.auth.getSession();

    if (error) throw error;

    res.json({
      status: "success",
      message: "Supabase client initialized successfully."
    });
  } catch {
    res.status(500).json({
      status: "error",
      message: "Supabase test failed."
    });
  }
});

// Create account
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof fullName !== "string" ||
      !email.trim() ||
      !password ||
      !fullName.trim()
    ) {
      return res.status(400).json({
        error: "Full name, email and password are required."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters."
      });
    }

    const base = fullName
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "explorer";

    const username = `${base}-${crypto.randomBytes(3).toString("hex")}`;

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          username,
          full_name: fullName.trim()
        }
      }
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
      message: data.session
        ? "Account created successfully."
        : "Account request received. Check your email if confirmation is required.",
      user: data.user ? publicUser(data.user) : null,
      session: data.session || null,
      sessionCreated: Boolean(data.session)
    });
  } catch (error) {
    console.error("Signup error:", error.message);

    res.status(500).json({
      error: "Registration failed due to a server error."
    });
  }
});

// Sign in
app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (error || !data.session || !data.user) {
      return res.status(401).json({
        error: error?.message || "Invalid email or password, or email confirmation is required."
      });
    }

    res.json({
      message: "Login successful.",
      user: publicUser(data.user),
      session: data.session
    });
  } catch (error) {
    console.error("Signin error:", error.message);

    res.status(500).json({
      error: "Login failed due to a server error."
    });
  }
});

// Check the current session
app.get("/api/auth/me", async (req, res) => {
  const { user, error } = await getAuthenticatedUser(req);

  if (error) {
    return res.status(401).json({ error });
  }

  res.json({ user: publicUser(user) });
});

// Refresh an expired or expiring access token
app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({
        error: "A refresh token is required."
      });
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken
    });

    if (error || !data.session || !data.user) {
      return res.status(401).json({
        error: "Your session has expired. Please sign in again."
      });
    }

    res.json({
      user: publicUser(data.user),
      session: data.session
    });
  } catch (error) {
    console.error("Session refresh error:", error.message);

    res.status(500).json({
      error: "Unable to refresh your session."
    });
  }
});

// Sign out
app.post("/api/auth/signout", (req, res) => {
  res.json({ message: "Signed out successfully." });
});

// Request password reset
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        error: "Enter your email address."
      });
    }

    const options = {};
    if (process.env.PASSWORD_RESET_REDIRECT_URL) {
      options.redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      options
    );

    if (error) {
      console.error("Password reset error:", error.message);

      return res.status(400).json({
        error: "Unable to request a password reset. Please try again."
      });
    }

    res.json({
      message: "If an account exists for that address, password-reset instructions will be sent."
    });
  } catch (error) {
    console.error("Password reset error:", error.message);

    res.status(500).json({
      error: "Unable to request a password reset."
    });
  }
});

// Update Profile
app.put("/api/profile", async (req, res) => {
  try {
    const { user, token, error: authError } = await getAuthenticatedUser(req);
    if (authError || !user) {
      return res.status(401).json({ error: authError || "Authentication required." });
    }

    const { fullName } = req.body;
    if (typeof fullName !== "string" || !fullName.trim()) {
      return res.status(400).json({ error: "Your full name is required." });
    }

    const userClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data, error } = await userClient.auth.updateUser({
      data: { full_name: fullName.trim() }
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({
      status: "success",
      message: "Profile updated successfully.",
      user: publicUser(data.user)
    });
  } catch (error) {
    console.error("Profile update error:", error.message);
    res.status(500).json({ error: "Unable to update profile." });
  }
});

// FieldNotebook - Local deterministic formatting (deprecated; generation is client-side in browser)
app.post("/api/ai/organize-notes", (req, res) => {
  res.json({
    status: "success",
    message: "Field notebook generation is processed deterministically in the client browser without AI dependencies."
  });
});

// Rock Identifier AI
app.post("/api/ai/identify-rock", async (req, res) => {
  try {
    const {
      category = "",
      texture = "",
      grainSize = "",
      color = "",
      environment = ""
    } = req.body;

    if (!category || !texture || !grainSize || !color) {
      return res.status(400).json({
        error: "Rock category, texture, grain size, and color are required."
      });
    }

    const prompt = `You are GeoGuide Rock Identifier AI, a rigorous assistant for geology students and field geologists.
Given the following rock observations:
- Rock category: ${category}
- Texture: ${texture}
- Grain size: ${grainSize}
- Color: ${color}
- Environment and context: ${environment || "Not specified"}

Analyze these physical properties carefully. Return a strictly valid JSON object matching this schema:
{
  "primaryMatch": {
    "name": "Most likely rock name",
    "confidence": "High / Moderate / Tentative",
    "reasoning": "Clear geological reasoning explaining how the texture, grain size, color and environment point to this rock.",
    "referenceUrl": ""
  },
  "alternatives": [
    {
      "name": "Alternative rock name",
      "confidence": "Plausible",
      "reasoning": "Why this alternative could match or how to distinguish it.",
      "referenceUrl": ""
    }
  ]
}

Provide 1 to 3 plausible alternative rock matches in the alternatives array. Ensure JSON is strictly valid with no trailing commas.`;

    const rawResponse = await generateWithGemini(prompt, { jsonMode: true });

    let parsedResult;
    try {
      parsedResult = JSON.parse(rawResponse);
    } catch {
      // If markdown backticks were returned, extract the JSON portion
      const match = rawResponse.match(/\{[\s\S]*\}/);
      if (match) {
        parsedResult = JSON.parse(match[0]);
      } else {
        throw new Error("Invalid JSON structure received from AI model.");
      }
    }

    res.json(parsedResult);
  } catch (error) {
    console.error("Rock Identifier AI error:", error.message);
    res.status(500).json({
      error: "Unable to identify rock at this moment. Please try again."
    });
  }
});

// OBSERVATIONS CRUD
// GET /api/observations
app.get("/api/observations", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const userId = user ? user.id : "anonymous";

    // Try Supabase first if observations table exists
    if (user) {
      try {
        const { data, error } = await supabase
          .from("observations")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (!error && Array.isArray(data)) {
          return res.json({ status: "success", observations: data });
        }
      } catch (err) {
        // Fall back to local store
      }
    }

    const all = readLocalObservations();
    const userObservations = all.filter((obs) => !obs.userId || obs.userId === userId);
    res.json({ status: "success", observations: userObservations });
  } catch (error) {
    console.error("GET observations error:", error.message);
    res.status(500).json({ error: "Could not retrieve observations." });
  }
});

// POST /api/observations
app.post("/api/observations", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const userId = user ? user.id : "anonymous";

    const {
      siteNumber = "",
      siteName = "",
      date = "",
      time = "",
      latitude = "",
      longitude = "",
      elevation = "",
      environment = "",
      rawNotes = "",
      extraInstructions = "",
      organizedNotes = ""
    } = req.body;

    if (!siteNumber || !date || !rawNotes) {
      return res.status(400).json({
        error: "Site number, date, and raw observations are required."
      });
    }

    const now = new Date().toISOString();
    const id = `obs_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    const newObservation = {
      ...req.body,
      id,
      userId,
      siteNumber,
      siteName,
      date,
      time,
      latitude,
      longitude,
      elevation,
      environment,
      rawNotes,
      extraInstructions,
      organizedNotes,
      createdAt: now,
      updatedAt: now
    };

    // Try Supabase insertion if available
    if (user) {
      try {
        const { data, error } = await supabase
          .from("observations")
          .insert([{
            id,
            user_id: userId,
            site_number: siteNumber,
            site_name: siteName,
            observation_date: date,
            time,
            latitude,
            longitude,
            elevation,
            environment,
            raw_notes: rawNotes,
            extra_instructions: extraInstructions,
            organized_notes: organizedNotes,
            created_at: now,
            updated_at: now
          }])
          .select()
          .single();

        if (!error && data) {
          return res.status(201).json({ status: "success", observation: data });
        }
      } catch (err) {
        // Fall back to local store
      }
    }

    const all = readLocalObservations();
    all.unshift(newObservation);
    writeLocalObservations(all);

    res.status(201).json({
      status: "success",
      observation: newObservation
    });
  } catch (error) {
    console.error("POST observation error:", error.message);
    res.status(500).json({ error: "Could not save observation." });
  }
});

// GET /api/observations/:id
app.get("/api/observations/:id", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const userId = user ? user.id : "anonymous";
    const { id } = req.params;

    if (user) {
      try {
        const { data, error } = await supabase
          .from("observations")
          .select("*")
          .eq("id", id)
          .eq("user_id", userId)
          .single();

        if (!error && data) {
          return res.json({ status: "success", observation: data });
        }
      } catch (err) {
        // Fall back
      }
    }

    const all = readLocalObservations();
    const found = all.find((o) => o.id === id && (!o.userId || o.userId === userId));

    if (!found) {
      return res.status(404).json({ error: "Observation not found." });
    }

    res.json({ status: "success", observation: found });
  } catch (error) {
    console.error("GET observation ID error:", error.message);
    res.status(500).json({ error: "Could not retrieve observation." });
  }
});

// PUT /api/observations/:id
app.put("/api/observations/:id", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const userId = user ? user.id : "anonymous";
    const { id } = req.params;

    const payload = req.body;
    const now = new Date().toISOString();

    if (user) {
      try {
        const { data, error } = await supabase
          .from("observations")
          .update({
            site_number: payload.siteNumber,
            site_name: payload.siteName,
            observation_date: payload.date,
            time: payload.time,
            latitude: payload.latitude,
            longitude: payload.longitude,
            elevation: payload.elevation,
            environment: payload.environment,
            raw_notes: payload.rawNotes,
            extra_instructions: payload.extraInstructions,
            organized_notes: payload.organizedNotes,
            updated_at: now
          })
          .eq("id", id)
          .eq("user_id", userId)
          .select()
          .single();

        if (!error && data) {
          return res.json({ status: "success", observation: data });
        }
      } catch (err) {
        // Fall back
      }
    }

    const all = readLocalObservations();
    const index = all.findIndex((o) => o.id === id && (!o.userId || o.userId === userId));

    if (index === -1) {
      return res.status(404).json({ error: "Observation not found." });
    }

    const updated = {
      ...all[index],
      ...payload,
      id,
      userId,
      updatedAt: now
    };

    all[index] = updated;
    writeLocalObservations(all);

    res.json({ status: "success", observation: updated });
  } catch (error) {
    console.error("PUT observation error:", error.message);
    res.status(500).json({ error: "Could not update observation." });
  }
});

// DELETE /api/observations/:id
app.delete("/api/observations/:id", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const userId = user ? user.id : "anonymous";
    const { id } = req.params;

    if (user) {
      try {
        const { error } = await supabase
          .from("observations")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);

        if (!error) {
          return res.json({ status: "success", message: "Observation deleted." });
        }
      } catch (err) {
        // Fall back
      }
    }

    const all = readLocalObservations();
    const filtered = all.filter((o) => !(o.id === id && (!o.userId || o.userId === userId)));
    writeLocalObservations(filtered);

    res.json({ status: "success", message: "Observation deleted." });
  } catch (error) {
    console.error("DELETE observation error:", error.message);
    res.status(500).json({ error: "Could not delete observation." });
  }
});

// Catch-all for API 404s so that it ALWAYS returns JSON, never HTML
app.use("/api", (req, res) => {
  res.status(404).json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`
  });
});

// Global Express error handler
app.use((err, req, res, next) => {
  console.error("[GeoGuide Error]", err);
  res.status(500).json({
    error: err.message || "An unexpected server error occurred."
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
