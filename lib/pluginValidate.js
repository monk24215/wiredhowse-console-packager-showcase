// Validates a set of generated WordPress plugin files before they are packaged.
// Generated code is never executed here — this is static checking only.

export const LIMITS = {
  maxFiles: 30,
  maxFileBytes: 200 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxDepth: 4,
};

const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

// Patterns that are almost never legitimate in a plugin and are the usual
// obfuscation / remote-code / shell-execution tells.
const FORBIDDEN = [
  { re: /\beval\s*\(/, why: "eval()" },
  { re: /\bbase64_decode\s*\(/, why: "base64_decode()" },
  { re: /\bgzinflate\s*\(/, why: "gzinflate()" },
  { re: /\bstr_rot13\s*\(/, why: "str_rot13()" },
  { re: /\bshell_exec\s*\(/, why: "shell_exec()" },
  { re: /\bpassthru\s*\(/, why: "passthru()" },
  { re: /\bproc_open\s*\(/, why: "proc_open()" },
  { re: /\bpopen\s*\(/, why: "popen()" },
  { re: /\bassert\s*\(/, why: "assert()" },
  { re: /\bsystem\s*\(/, why: "system()" },
  { re: /\bexec\s*\(/, why: "exec()" },
  { re: /\b(include|require)(_once)?\s*\(?\s*['"]https?:\/\//, why: "remote include" },
];

function checkPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 120) {
    return "invalid file path";
  }
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return `unsafe path "${path}"`;
  }
  if (!PATH_RE.test(path)) {
    return `disallowed characters in path "${path}"`;
  }
  if (path.split("/").length > LIMITS.maxDepth) {
    return `path too deep "${path}"`;
  }
  return null;
}

// Returns { ok, errors, warnings, files } — files is the normalized map on success.
export function validatePluginFiles(files) {
  const errors = [];
  const warnings = [];

  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { ok: false, errors: ["files must be an object of {path: content}"], warnings, files: null };
  }

  const entries = Object.entries(files);
  if (entries.length === 0) {
    errors.push("no files generated");
  }
  if (entries.length > LIMITS.maxFiles) {
    errors.push(`too many files (${entries.length} > ${LIMITS.maxFiles})`);
  }

  let total = 0;
  for (const [path, content] of entries) {
    const pathErr = checkPath(path);
    if (pathErr) {
      errors.push(pathErr);
      continue;
    }
    if (typeof content !== "string") {
      errors.push(`"${path}" is not text`);
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    total += bytes;
    if (bytes > LIMITS.maxFileBytes) {
      errors.push(`"${path}" exceeds ${LIMITS.maxFileBytes} bytes`);
    }
    if (path.endsWith(".php")) {
      if (!content.trimStart().startsWith("<?php")) {
        errors.push(`"${path}" does not start with <?php`);
      }
      for (const { re, why } of FORBIDDEN) {
        if (re.test(content)) {
          errors.push(`"${path}" uses forbidden construct: ${why}`);
        }
      }
    }
  }
  if (total > LIMITS.maxTotalBytes) {
    errors.push(`total size exceeds ${LIMITS.maxTotalBytes} bytes`);
  }

  // Exactly one root-level PHP file must carry the WordPress plugin header.
  const rootPhp = entries.filter(([p]) => !p.includes("/") && p.endsWith(".php"));
  const headered = rootPhp.filter(([, c]) => /^\s*\*?\s*Plugin Name:\s*\S/m.test(String(c)));
  if (headered.length === 0) {
    errors.push("no root PHP file with a 'Plugin Name:' header");
  } else if (headered.length > 1) {
    errors.push("more than one root PHP file declares a 'Plugin Name:' header");
  }

  const hasUninstall = entries.some(
    ([p, c]) => p === "uninstall.php" || /register_uninstall_hook\s*\(/.test(String(c))
  );
  if (!hasUninstall) {
    warnings.push("no uninstall handler (uninstall.php or register_uninstall_hook)");
  }

  return { ok: errors.length === 0, errors, warnings, files: errors.length === 0 ? files : null };
}
