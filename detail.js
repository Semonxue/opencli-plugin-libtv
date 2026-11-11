import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, byType, formatDate, loadCanvas, mb, sumBytes } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "detail",
  description: "Summarise one LibTV canvas: nodes, assets by type, groups, size, models.",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv detail 5110c03295d34f64aff6e398cb91d764",
  args: [
    { name: "project", positional: true, required: true, help: "Project uuid, numeric id, or name substring" }
  ],
  columns: ["name", "uuid", "nodes", "images", "videos", "audio", "groups", "assets", "size_mb", "size_unknown", "models", "updated", "url"],
  func: async (page, kwargs) => {
    const canvas = await loadCanvas(page, String(kwargs.project));
    const p = canvas.project;
    const models = /* @__PURE__ */ new Map();
    for (const a of canvas.assets) models.set(a.model, (models.get(a.model) ?? 0) + 1);
    const modelMix = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}:${n}`).join(", ");
    const unknown = canvas.assets.filter((a) => !a.bytes).length;
    return [
      {
        name: p.name,
        uuid: p.uuid,
        nodes: canvas.nodeCount,
        images: byType(canvas.assets, "image").length,
        videos: byType(canvas.assets, "video").length,
        audio: byType(canvas.assets, "audio").length,
        groups: canvas.groups.length,
        assets: canvas.assets.length,
        size_mb: mb(sumBytes(canvas.assets)),
        size_unknown: unknown,
        models: modelMix,
        updated: formatDate(p.updatedAtMs),
        url: p.url
      }
    ];
  }
});
