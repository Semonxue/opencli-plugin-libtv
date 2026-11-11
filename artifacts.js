import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listArtifacts, resolveProject } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "artifacts",
  aliases: ["history"],
  description: "List generated artifacts across projects (task, media type, dimensions, url).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv artifacts --limit 30 --media video",
  args: [
    { name: "limit", type: "int", default: 30, help: "Max artifacts (default: 30)" },
    { name: "media", choices: ["all", "image", "video", "audio"], default: "all", help: "Filter by media type" },
    { name: "project", default: "", help: "Only artifacts from this project (uuid / id / name)" }
  ],
  columns: ["#", "media", "size_px", "project", "node_key", "created", "url"],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 30;
    const media = String(kwargs.media ?? "all");
    let projectUuid = "";
    if (kwargs.project) {
      projectUuid = (await resolveProject(page, String(kwargs.project))).uuid;
    }
    const rows = await listArtifacts(page, {
      limit,
      projectUuid,
      mediaType: media === "all" ? "" : media
    });
    return rows.map((a, i) => ({
      "#": i + 1,
      media: a.mediaType,
      size_px: a.width ? `${a.width}x${a.height}` : "",
      project: a.projectUuid,
      node_key: a.nodeKey,
      created: formatDate(a.createdAtMs),
      url: a.url
    }));
  }
});
