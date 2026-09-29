import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("loads the built ACP plugin with the locked dsh host", () => {
    const result = spawnSync(process.execPath, ["-e", "import('./dist/plugin.js')"], {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
});
