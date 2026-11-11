import { cli, Strategy } from "@jackwener/opencli/registry";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "opencli-plugin.json"), "utf-8"));
cli({
  site: "libtv",
  name: "version",
  description: "Show the LibTV plugin version.",
  access: "read",
  strategy: Strategy.PUBLIC,
  browser: false,
  example: "opencli libtv version",
  columns: ["name", "version"],
  func: async () => [
    { name: manifest.name ?? "libtv", version: manifest.version ?? "unknown" }
  ]
});
