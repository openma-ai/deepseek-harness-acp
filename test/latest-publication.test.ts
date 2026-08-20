import { describe, expect, it } from "vitest";
import { LatestPublication } from "../src/bridge/latest-publication.js";

describe("LatestPublication", () => {
    it("drops an older async snapshot that resolves after the latest one", async () => {
        const publications = new LatestPublication();
        const delivered: string[] = [];
        let resolveOld!: (value: string) => void;
        const oldValue = new Promise<string>((resolve) => {
            resolveOld = resolve;
        });

        const old = publications.run("session", () => oldValue, (value) => delivered.push(value));
        const latest = publications.run("session", async () => "latest", (value) => delivered.push(value));
        await latest;
        resolveOld("stale");
        await old;

        expect(delivered).toEqual(["latest"]);
    });

    it("invalidates an in-flight snapshot when its session is retired", async () => {
        const publications = new LatestPublication();
        const delivered: string[] = [];
        let resolve!: (value: string) => void;
        const value = new Promise<string>((done) => {
            resolve = done;
        });

        const pending = publications.run("session", () => value, (entry) => delivered.push(entry));
        publications.invalidate("session");
        resolve("retired");
        await pending;

        expect(delivered).toEqual([]);
    });
});
