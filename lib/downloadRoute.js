// Serves a generated WordPress plugin zip to the owner of the build.
// Registered in server.js behind the same session/auth gate as the other /api/builds routes.

import fs from "node:fs/promises";
import path from "node:path";
import { isConfigured, getBuildRequestForUser } from "../db.js";
import { ASSETS_DIR } from "../hosting.js";

export function registerDownloadRoute(app) {
  app.get("/api/builds/:id/download", async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });

    const job = await getBuildRequestForUser(id, req.session.auth_user.email);
    if (!job) return res.status(404).json({ error: "Build not found." });

    const dir = path.join(ASSETS_DIR, String(id), "download");
    let zips = [];
    try {
      zips = (await fs.readdir(dir)).filter((f) => f.endsWith(".zip"));
    } catch {
      zips = [];
    }
    if (zips.length === 0) return res.status(404).json({ error: "Plugin file not found." });

    res.download(path.join(dir, zips[0]));
  });
}
