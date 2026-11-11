import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, loadCanvas, mb } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "groups",
  aliases: ["tree"],
  description: "List canvas groups with child counts and per-type asset totals.",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv groups 5110c03295d34f64aff6e398cb91d764",
  args: [
    { name: "project", positional: true, required: true, help: "Canvas URL, project uuid, numeric id, or name substring" },
    { name: "ungrouped", type: "bool", default: true, help: "Include a row for ungrouped assets" }
  ],
  columns: ["group", "nodes", "images", "videos", "audio", "size_mb", "size_unknown", "role_id"],
  func: async (page, kwargs) => {
    const canvas = await loadCanvas(page, String(kwargs.project));
    const rows = canvas.groups.map((g) => {
      const inGroup = canvas.assets.filter((a) => a.group === g.name);
      return {
        group: g.name,
        nodes: g.childCount,
        images: inGroup.filter((a) => a.type === "image").length,
        videos: inGroup.filter((a) => a.type === "video").length,
        audio: inGroup.filter((a) => a.type === "audio").length,
        size_mb: mb(inGroup.reduce((s, a) => s + (a.bytes || 0), 0)),
        size_unknown: inGroup.filter((a) => !a.bytes).length,
        role_id: g.roleId || ""
      };
    });
    if (kwargs.ungrouped !== false) {
      const loose = canvas.assets.filter((a) => !a.group);
      if (loose.length) {
        rows.push({
          group: "_ungrouped",
          nodes: canvas.flatNodes.filter((n) => !n.group).length,
          images: loose.filter((a) => a.type === "image").length,
          videos: loose.filter((a) => a.type === "video").length,
          audio: loose.filter((a) => a.type === "audio").length,
          size_mb: mb(loose.reduce((s, a) => s + (a.bytes || 0), 0)),
          size_unknown: loose.filter((a) => !a.bytes).length,
          role_id: ""
        });
      }
    }
    return rows;
  }
});
