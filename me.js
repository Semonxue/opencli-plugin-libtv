import { cli, Strategy } from "@jackwener/opencli/registry";
import { LIBTV_DOMAIN, LIBTV_HOME, readAccount } from "./lib/utils.js";
cli({
  site: "libtv",
  name: "me",
  description: "Utility: show the logged-in account (plan, total/usable power, free power, concurrency).",
  access: "read",
  domain: LIBTV_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: LIBTV_HOME,
  example: "opencli libtv me -f json",
  columns: ["name", "level", "package_type", "total_power", "usable_power", "libtv_power", "free_power", "concurrent"],
  func: async (page) => {
    const acc = await readAccount(page);
    return [
      {
        name: acc.name,
        level: acc.level,
        package_type: acc.packageType,
        total_power: acc.totalPower,
        usable_power: acc.usablePower,
        libtv_power: acc.libtvUsablePower,
        free_power: acc.freePower,
        concurrent: acc.concurrent
      }
    ];
  }
});
