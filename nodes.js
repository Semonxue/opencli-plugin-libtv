import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, loadCanvas, mb } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "nodes",
  description: "List canvas nodes (type, model, group, dimensions, duration, size, url).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv nodes 5110c03295d34f64aff6e398cb91d764 --type image --limit 30",
  args: [
    { name: "project", positional: true, required: true, help: "Canvas URL, project uuid, numeric id, or name substring" },
    { name: "type", choices: ["all", "image", "video", "audio", "group"], default: "all", help: "Filter by node type" },
    { name: "group", default: "", help: "Filter by group name substring" },
    { name: "limit", type: "int", default: 0, help: "Max rows (0 = all)" }
  ],
  columns: ["#", "type", "name", "model", "group", "size_px", "duration_sec", "size_mb", "node_key", "url"],
  func: async (page, kwargs) => {
    const canvas = await loadCanvas(page, String(kwargs.project));
    const type = String(kwargs.type ?? "all");
    const groupNeedle = String(kwargs.group ?? "").toLowerCase();
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 0;
    const rows = canvas.flatNodes.filter((n) => type === "all" ? true : n.type === type).filter((n) => groupNeedle ? n.group.toLowerCase().includes(groupNeedle) : true).slice(0, limit || void 0).map((n, i) => ({
      "#": i + 1,
      type: n.type,
      name: n.name,
      model: n.model,
      group: n.group || "\u2014",
      size_px: n.width ? `${n.width}x${n.height}` : "",
      duration_sec: n.durationSec === "" ? "" : Number(n.durationSec),
      size_mb: n.bytes ? mb(n.bytes) : "",
      node_key: n.nodeKey,
      url: n.url
    }));
    return rows;
  }
});
