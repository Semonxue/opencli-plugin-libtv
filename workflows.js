import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listWorkflows } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "workflows",
  description: "List saved LibTV workflows (uuid, name, updated).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv workflows",
  args: [{ name: "limit", type: "int", default: 100, help: "Max workflows (default: 100)" }],
  columns: ["uuid", "name", "updated"],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 100;
    const rows = await listWorkflows(page, limit);
    return rows.map((w) => ({ uuid: w.uuid, name: w.name, updated: formatDate(w.updatedAtMs) }));
  }
});
