/**
 * Localhost fallback for Agent Auth when `authenticate` has no `_meta` key.
 * The page never sends the secret back over ACP.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";

export interface LocalAuthPage {
    url: string;
    close: () => void;
    completed: Promise<string>;
}

export function startLocalAuthPage(options: {
    credentialName: string;
    timeoutMs?: number;
}): Promise<LocalAuthPage> {
    return new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            void handle(request, response);
        });
        let settle: ((key: string) => void) | undefined;
        let fail: ((error: Error) => void) | undefined;
        const completed = new Promise<string>((res, rej) => {
            settle = res;
            fail = rej;
        });
        const timeoutMs = options.timeoutMs ?? 10 * 60_000;
        const timer = setTimeout(() => {
            server.close();
            fail?.(new Error("local auth page timed out"));
        }, timeoutMs);
        timer.unref?.();

        const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
            if (request.method === "GET" || request.method === undefined) {
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                response.end(authPageHtml(options.credentialName));
                return;
            }
            if (request.method === "POST") {
                const body = await readBody(request);
                const key = new URLSearchParams(body).get("api-key")?.trim() ?? "";
                if (key.length === 0) {
                    response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
                    response.end(authPageHtml(options.credentialName, "Enter an API key."));
                    return;
                }
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                response.end(
                    "<!doctype html><html><body><p>Saved. You can return to the client.</p></body></html>",
                );
                clearTimeout(timer);
                server.close();
                settle?.(key);
                return;
            }
            response.writeHead(405);
            response.end();
        };

        server.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("local auth page failed to bind"));
                return;
            }
            const url = `http://127.0.0.1:${address.port}/`;
            resolve({
                url,
                close: () => {
                    clearTimeout(timer);
                    server.close();
                },
                completed,
            });
        });
    });
}

export function openLocalAuthPage(url: string): void {
    const platform = process.platform;
    if (platform === "darwin") {
        execFile("open", [url], () => undefined);
        return;
    }
    if (platform === "win32") {
        execFile("cmd", ["/c", "start", "", url], () => undefined);
        return;
    }
    execFile("xdg-open", [url], () => undefined);
}

function authPageHtml(credentialName: string, error?: string): string {
    const message = error ? `<p>${escapeHtml(error)}</p>` : "";
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>DeepSeek Harness sign in</title></head>
<body>
  <h1>Save API key</h1>
  <p>Stored as ${escapeHtml(credentialName)} in the harness credential store.</p>
  ${message}
  <form method="post">
    <label>API key <input type="password" name="api-key" autocomplete="off" required></label>
    <button type="submit">Save</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char
    ));
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk));
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}
