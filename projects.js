import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listProjects } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "projects",
  aliases: ["ls"],
  description: "Core: list canvas projects (uuid, name, space, updated, url).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv projects --limit 20 -f json",
  args: [
    { name: "limit", type: "int", default: 50, help: "Max projects to return (default: 50)" },
    { name: "search", default: "", help: "Filter by project name substring" },
    { name: "space", type: "int", default: 0, help: "Only projects in this space/folder id (see space_id)" }
  ],
  columns: ["uuid", "name", "space_id", "updated", "url"],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 50;
    const spaceId = Number(kwargs.space) > 0 ? Number(kwargs.space) : 0;
    const rows = await listProjects(page, { limit, search: String(kwargs.search ?? ""), spaceId });
    return rows.map((p) => ({
      uuid: p.uuid,
      name: p.name,
      space_id: p.projectSpaceId,
      updated: formatDate(p.updatedAtMs),
      url: p.url
    }));
  }
});
