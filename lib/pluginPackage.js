// Packages validated plugin files into an installable WordPress zip.
// WordPress expects a zip whose single top-level folder is the plugin slug.

import JSZip from "jszip";

export function pluginSlug(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
  return slug || "my-plugin";
}

// files: { "path/in/plugin.php": "content", ... } (already validated)
// Returns { slug, filename, buffer }.
export async function packagePlugin(name, files) {
  const slug = pluginSlug(name);
  const zip = new JSZip();
  const folder = zip.folder(slug);
  for (const [path, content] of Object.entries(files)) {
    folder.file(path, content);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { slug, filename: `${slug}.zip`, buffer };
}
