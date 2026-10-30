import assert from "node:assert/strict";
import { validatePluginFiles } from "../lib/pluginValidate.js";
import { packagePlugin, pluginSlug } from "../lib/pluginPackage.js";

const good = {
  "hello-world.php": "<?php\n/**\n * Plugin Name: Hello World\n * Version: 1.0.0\n */\nif ( ! defined( 'ABSPATH' ) ) { exit; }\n",
  "uninstall.php": "<?php\nif ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) { exit; }\n",
};

let r = validatePluginFiles(good);
assert.equal(r.ok, true, r.errors.join("; "));
assert.equal(r.warnings.length, 0);

assert.equal(validatePluginFiles({ ...good, "../evil.php": "<?php" }).ok, false);
assert.equal(validatePluginFiles({ ...good, "/etc/x.php": "<?php" }).ok, false);

r = validatePluginFiles({ ...good, "inc.php": "<?php eval(base64_decode('x'));" });
assert.equal(r.ok, false);
assert.ok(r.errors.some((e) => e.includes("eval()")));

r = validatePluginFiles({ "a.php": "<?php echo 1;" });
assert.equal(r.ok, false);

r = validatePluginFiles({ "hello-world.php": good["hello-world.php"] });
assert.equal(r.ok, true);
assert.equal(r.warnings.length, 1);

assert.equal(pluginSlug("Hello World!"), "hello-world");
const pkg = await packagePlugin("Hello World", good);
assert.equal(pkg.filename, "hello-world.zip");
assert.ok(pkg.buffer.length > 100);

console.log("plugin tests passed");
