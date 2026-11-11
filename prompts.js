import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, loadCanvas } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "prompts",
  description: "Core: list the generation prompt behind each canvas media node.",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv prompts 0123456789abcdef0123456789abcdef --type video",
  args: [
    { name: "project", positional: true, required: true, help: "Canvas URL, project uuid, numeric id, or name substring" },
    { name: "type", choices: ["all", "image", "video", "audio"], default: "all", help: "Filter by media type" },
    { name: "group", default: "", help: "Filter by group name substring" },
    { name: "limit", type: "int", default: 0, help: "Max rows (0 = all)" }
  ],
  columns: ["#", "type", "group", "name", "model", "prompt"],
  func: async (page, kwargs) => {
    const canvas = await loadCanvas(page, String(kwargs.project));
    const type = String(kwargs.type ?? "all");
    const groupNeedle = String(kwargs.group ?? "").toLowerCase();
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 0;
    return canvas.assets.filter((a) => type === "all" ? true : a.type === type).filter((a) => groupNeedle ? a.group.toLowerCase().includes(groupNeedle) : true).slice(0, limit || void 0).map((a, i) => ({
      "#": i + 1,
      type: a.type,
      group: a.group || "\u2014",
      name: a.name,
      model: a.model,
      prompt: a.prompt
    }));
  }
});
