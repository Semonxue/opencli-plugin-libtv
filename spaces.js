import { cli, Strategy } from "@jackwener/opencli/registry";
import { CANVAS_HOST, LIBTV_DOMAIN, LIBTV_HOME, callApi, canvasUrl, formatDate } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "spaces",
  description: "List LibTV spaces/folders, or the canvases inside one (--inside <spaceId>).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv spaces --inside 11161198",
  args: [
    { name: "limit", type: "int", default: 100, help: "Max rows (default: 100)" },
    { name: "inside", type: "int", default: 0, help: "List the canvases inside this space/folder id" },
    { name: "search", default: "", help: "Filter by name substring" }
  ],
  columns: ["kind", "id", "name", "items", "updated", "url"],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 100;
    const needle = String(kwargs.search ?? "").toLowerCase();
    const inside = Number(kwargs.inside ?? 0);
    const rows = [];
    if (inside > 0) {
      let pageNum2 = 1;
      while (rows.length < limit && pageNum2 <= 20) {
        const data = await callApi(page, CANVAS_HOST, "/api/canvas/project/list", {
          body: { folderId: inside, page: pageNum2, pageSize: 50 }
        });
        const items = Array.isArray(data?.projectMetaList) ? data.projectMetaList : [];
        for (const it of items) {
          const name = String(it?.name ?? "(untitled)");
          if (needle && !name.toLowerCase().includes(needle)) continue;
          rows.push({
            kind: "project",
            id: String(it?.uuid ?? ""),
            name,
            items: 0,
            updated: formatDate(Number(it?.updatedAtMs ?? 0)),
            url: canvasUrl(String(it?.uuid ?? ""))
          });
          if (rows.length >= limit) break;
        }
        if (items.length < 50) break;
        pageNum2++;
      }
      return rows;
    }
    let pageNum = 1;
    while (rows.length < limit && pageNum <= 20) {
      const data = await callApi(page, CANVAS_HOST, "/api/canvas/folder/entries", {
        body: { id: 0, onlyFolder: true, spaceTypes: [10], page: pageNum, pageSize: 50 }
      });
      const items = Array.isArray(data?.folders) ? data.folders : [];
      for (const it of items) {
        const name = String(it?.name ?? "");
        if (needle && !name.toLowerCase().includes(needle)) continue;
        rows.push({
          kind: "space",
          id: String(it?.id ?? ""),
          name,
          items: Number(it?.fileCnt ?? 0),
          updated: formatDate(Number(it?.updateAt ? Date.parse(it.updateAt) : it?.updatedAtMs ?? 0)),
          url: ""
        });
        if (rows.length >= limit) break;
      }
      if (items.length < 50) break;
      pageNum++;
    }
    return rows;
  }
});
