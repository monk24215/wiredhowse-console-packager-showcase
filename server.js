import { registerDownloadRoute } from "./lib/downloadRoute.js";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import {
  isConfigured,
  runMigrations,
  resetStaleRunningRequests,
  reserveQuotaSlot,
  createBuildRequest,
  listBuildRequestsForUser,
  getBuildRequestForUser,
  markBuildTornDown,
  setCustomDomain,
  clearCustomDomain,
  getUserAnthropicKey,
  setUserAnthropicKey,
  clearUserAnthropicKey,
  incrementEditCount,
  MAX_EDITS_PER_BUILD,
  getLiveBuildById,
  getLiveBuildByCustomDomain,
  isCustomDomainTaken,
} from "./db.js";
import { TEMPLATES, DEFAULT_TEMPLATE_ID, isValidTemplate } from "./templates.js";
import { startWorker, GITHUB_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./worker.js";
import {
  isHostingConfigured,
  assetHostRouter,
  buildIdFromAssetHost,
  isUnderAssetBaseDomain,
  removeAsset,
  updateAssetFile,
  checkCustomDomain,
  dnsRecordsFor,
  CONSOLE_HOST,
} from "./hosting.js";
import { deleteRepo, putFile, getFileContent, addCollaborator } from "./githubApi.js";
import { generateSiteEdit } from "./contentGenerator.js";

const AUTH_SECRET = process.env.AUTH_SECRET || "";
const AUTH_SERVER = process.env.AUTH_SERVER || "https://auth.wiredhowse.app";
const SESSION_SECRET = process.env.SESSION_SECRET || AUTH_SECRET;
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const DEV_LOGIN_EMAIL = process.env.DEV_LOGIN_EMAIL || "";
const SUGGESTIONS_EMAIL = process.env.SUGGESTIONS_EMAIL || "suggestions@wiredhowse.app";

const app = express();
app.set("trust proxy", 1);

async function lookupAssetHost(host) {
  if (!isConfigured()) return null;
  const id = buildIdFromAssetHost(host);
  if (id !== null) return getLiveBuildById(id);
  if (isUnderAssetBaseDomain(host)) return null;
  return getLiveBuildByCustomDomain(host);
}

app.use(assetHostRouter(lookupAssetHost));

app.get("/internal/tls-ask", async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  if (!domain) return res.status(400).end();
  if (CONSOLE_HOST && domain === CONSOLE_HOST) return res.status(200).end();
  try {
    const build = await lookupAssetHost(domain);
    return res.status(build ? 200 : 404).end();
  } catch (err) {
    console.error("tls-ask lookup failed:", err.message || err);
    return res.status(503).end();
  }
});

app.use(express.json());

app.use(
  cookieSession({
    name: "wh_console_sess",
    secret: SESSION_SECRET || "dev-only-insecure-secret-do-not-use-in-prod",
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
);

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "wp-plugin-creator",
    section: 3,
    authConfigured: Boolean(AUTH_SECRET),
    dbConfigured: isConfigured(),
    hostingConfigured: isHostingConfigured(),
  });
});

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function verifyAuthToken(token) {
  if (!AUTH_SECRET) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  const expectedSig = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/internal/tls-ask") return next();

  if (req.session && req.session.auth_user) return next();

  if (req.query._auth_token) {
    const payload = verifyAuthToken(req.query._auth_token);
    if (payload) {
      req.session.auth_user = { email: payload.email, role: payload.role || "user" };
      const clean = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
      clean.searchParams.delete("_auth_token");
      return res.redirect(clean.pathname + clean.search);
    }
  }

  if (DEV_LOGIN_EMAIL && ["localhost", "127.0.0.1"].includes(req.hostname)) {
    req.session.auth_user = { email: DEV_LOGIN_EMAIL, role: "admin" };
    return next();
  }

  const returnUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return res.redirect(`${AUTH_SERVER}/?return=${encodeURIComponent(returnUrl)}`);
});

app.get("/", async (req, res) => {
  const user = req.session.auth_user;
  const dbReady = isConfigured();
  let anthropicKeyConfigured = false;
  if (dbReady) {
    try {
      anthropicKeyConfigured = Boolean(await getUserAnthropicKey(user.email));
    } catch (err) {
      console.error("GET / — could not check user Anthropic key:", err.message || err);
    }
  }

  const keyStatus = anthropicKeyConfigured
    ? 'Your API key · <a href="#" id="clearKeyLink">use shared</a>'
    : 'Shared key · <a href="#" id="setKeyLink">use your own</a>';
  const disabled = dbReady ? "" : "disabled";
  const dbReadyJs = dbReady ? "true" : "false";
  const dbMsg = dbReady ? "" : "Database isn’t ready yet — builds are temporarily unavailable.";

  let page = fs.readFileSync(path.join(__dirname, "views", "console.html"), "utf8");
  page = page
    .replaceAll("{{USER_EMAIL}}", String(user.email).replace(/&/g,"&amp;").replace(/</g,"&lt;"))
    .replaceAll("{{SUGGESTIONS_EMAIL}}", SUGGESTIONS_EMAIL)
    .replaceAll("{{MAX_EDITS}}", String(MAX_EDITS_PER_BUILD))
    .replaceAll("{{DISABLED}}", disabled)
    .replaceAll("{{DB_READY}}", dbReadyJs)
    .replaceAll("{{KEY_STATUS}}", keyStatus)
    .replaceAll("{{DB_MSG}}", dbMsg);

  res.type("html").send(page);
});

registerDownloadRoute(app);

app.get("/api/builds", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const jobs = await listBuildRequestsForUser(req.session.auth_user.email);
  res.json(jobs);
});

app.post("/api/builds", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const prompt = String(req.body?.prompt || "").trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: "Prompt is required." });

  const templateId = isValidTemplate(req.body?.templateId) ? req.body.templateId : DEFAULT_TEMPLATE_ID;
  const userEmail = req.session.auth_user.email;

  try {
    const quota = await reserveQuotaSlot(userEmail);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Monthly build limit reached (${quota.used}/${quota.limit}). Try again next month.`,
      });
    }
    const job = await createBuildRequest({ userEmail, prompt, templateId });
    res.status(201).json(job);
  } catch (err) {
    console.error("POST /api/builds failed:", err);
    res.status(500).json({ error: "Could not create build request." });
  }
});

app.delete("/api/builds/:id", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });

  const notes = [];
  if (job.github_owner && job.github_repo && GITHUB_TOKEN) {
    try {
      await deleteRepo(GITHUB_TOKEN, job.github_owner, job.github_repo);
    } catch (err) {
      notes.push(`GitHub repo delete failed: ${err.message || err}`);
    }
  }
  try {
    await removeAsset(id);
  } catch (err) {
    notes.push(`Asset files remove failed: ${err.message || err}`);
  }
  await markBuildTornDown(id, notes.length ? notes.join("; ") : null);
  res.json({ ok: true, notes });
});

app.post("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const domain = String(req.body?.domain || "").trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: "Domain is required." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (job.status !== "complete") return res.status(409).json({ error: "Build is not ready." });

  if (await isCustomDomainTaken(domain, id)) {
    return res.status(409).json({ error: "That domain is already attached to another build." });
  }

  await setCustomDomain(id, { domain, customDomainId: null });
  const status = await checkCustomDomain(domain, id);
  res.json({ ok: true, ...status, dnsRecords: dnsRecordsFor(domain, id) });
});

app.get("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (!job.custom_domain) return res.status(404).json({ error: "No custom domain set." });
  const status = await checkCustomDomain(job.custom_domain, id);
  res.json(status);
});

app.delete("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  await clearCustomDomain(id);
  res.json({ ok: true });
});

app.post("/api/builds/:id/edit", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const instructions = String(req.body?.instructions || "").trim().slice(0, 1000);
  if (!instructions) return res.status(400).json({ error: "Instructions are required." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (job.status !== "complete") return res.status(409).json({ error: "Build is not ready." });
  if ((job.edit_count || 0) >= MAX_EDITS_PER_BUILD) {
    return res.status(429).json({ error: `Edit limit reached (${MAX_EDITS_PER_BUILD}).` });
  }
  if (!job.github_owner || !job.github_repo) {
    return res.status(409).json({ error: "No repo recorded for this build." });
  }
  if (!GITHUB_TOKEN) return res.status(503).json({ error: "GitHub credentials not configured." });

  let apiKey = ANTHROPIC_API_KEY;
  try {
    apiKey = (await getUserAnthropicKey(req.session.auth_user.email)) || ANTHROPIC_API_KEY;
  } catch (err) {
    console.error(`POST /api/builds/${id}/edit — could not resolve Anthropic key:`, err.message || err);
  }
  if (!apiKey) return res.status(503).json({ error: "No Anthropic API key available." });

  try {
    const currentHtml = await getFileContent(GITHUB_TOKEN, job.github_owner, job.github_repo, "public/index.html");
    const revised = await generateSiteEdit(apiKey, ANTHROPIC_MODEL, job.prompt, currentHtml, instructions);
    await putFile(GITHUB_TOKEN, job.github_owner, job.github_repo, "public/index.html", revised, `Edit: ${instructions.slice(0, 72)}`);
    await updateAssetFile(id, "public/index.html", revised);
    const editCount = await incrementEditCount(id);
    res.json({ ok: true, editCount });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.post("/api/builds/:id/github-access", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const githubUsername = String(req.body?.githubUsername || "").trim();
  if (!githubUsername) return res.status(400).json({ error: "GitHub username is required." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (!job.github_owner || !job.github_repo) {
    return res.status(409).json({ error: "No repo recorded for this build." });
  }
  if (!GITHUB_TOKEN) return res.status(503).json({ error: "GitHub credentials not configured." });

  try {
    await addCollaborator(GITHUB_TOKEN, job.github_owner, job.github_repo, githubUsername);
    res.json({ ok: true, repo: `${job.github_owner}/${job.github_repo}` });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.post("/api/settings/anthropic-key", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const key = String(req.body?.key || "").trim();
  if (!key || !key.startsWith("sk-ant-")) {
    return res.status(400).json({ error: "That doesn't look like an Anthropic API key (should start with sk-ant-)." });
  }
  try {
    await setUserAnthropicKey(req.session.auth_user.email, key);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/settings/anthropic-key failed:", err.message || err);
    res.status(500).json({ error: "Could not save key." });
  }
});

app.delete("/api/settings/anthropic-key", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  try {
    await clearUserAnthropicKey(req.session.auth_user.email);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/settings/anthropic-key failed:", err.message || err);
    res.status(500).json({ error: "Could not remove key." });
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect(`${AUTH_SERVER}/logout.php`);
});

const port = process.env.PORT || 8080;

runMigrations()
  .then(() => resetStaleRunningRequests())
  .catch((err) => console.error("Migration/startup error:", err))
  .finally(() => {
    startWorker();
    app.listen(port, () => {
      console.log(`wiredhowse-console listening on ${port}`);
    });
  });
