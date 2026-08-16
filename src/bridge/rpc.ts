/**
 * Private JSON-RPC extension seam on the same ACP message stream.
 *
 * The bridge uses this only for the negotiated TUI Client inspect/run plane.
 * It is deliberately not exposed as a Cordis service or a general ACP method
 * registry. Palette/snapshot traffic is compositor-private on the client mux,
 * not this agent stream. Unknown methods still reach AgentSideConnection.
 */

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

/** Handler for one extra JSON-RPC request method. */
export type AcpRpcHandler = (params: unknown) => unknown | Promise<unknown>;

/** Bridge-owned extra methods and outbound notifications on the ACP stream. */
export class AcpRpc {
    private readonly handlers = new Map<string, AcpRpcHandler>();
    private writeJson: ((value: unknown) => void) | undefined;

    /**
     * Bind the mux writer. Called once from {@link muxAcpStream}.
     * @param writeJson - write one JSON-RPC message onto the ACP stream.
     */
    attachWriter(writeJson: (value: unknown) => void): void {
        this.writeJson = writeJson;
    }

    /**
     * Register a bridge-owned request method intercepted before the ACP SDK.
     * @param method - JSON-RPC method name (e.g. `tui/refresh`).
     * @param handler - implementation.
     * @returns disposer.
     */
    registerMethod(method: string, handler: AcpRpcHandler): () => void {
        if (this.handlers.has(method)) {
            throw new Error(`acpRpc: method ${JSON.stringify(method)} is already registered`);
        }
        this.handlers.set(method, handler);
        return () => {
            this.handlers.delete(method);
        };
    }

    /**
     * @param method - JSON-RPC method name.
     * @returns whether a TUI/extension handler owns this request.
     */
    has(method: string): boolean {
        return this.handlers.has(method);
    }

    /**
     * Dispatch one intercepted request and write the JSON-RPC response.
     * @param id - JSON-RPC id.
     * @param method - method name.
     * @param params - params object.
     */
    async dispatch(id: unknown, method: string, params: unknown): Promise<void> {
        const handler = this.handlers.get(method);
        const write = this.writeJson;
        if (handler === undefined || write === undefined) return;
        try {
            const result = await handler(params);
            write({ jsonrpc: "2.0", id, result: result ?? null });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        }
    }

    /**
     * Send a JSON-RPC notification on the ACP stream (e.g. `tui/snapshot`).
     * @param method - notification method.
     * @param params - payload.
     */
    notify(method: string, params?: unknown): void {
        const write = this.writeJson;
        if (write === undefined) return;
        write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
    }
}

function isInterceptedRequest(
    message: AnyMessage,
    rpc: AcpRpc,
): message is AnyMessage & { method: string; id: string | number | null; params?: unknown } {
    return (
        "method" in message &&
        typeof message.method === "string" &&
        "id" in message &&
        message.id !== undefined &&
        rpc.has(message.method)
    );
}

/**
 * Split ACP SDK traffic from extension methods on one Stream.
 * @param stream - decoded ACP JSON-RPC messages (`ndJsonStream` output).
 * @param rpc - extension registry.
 * @returns a Stream safe to hand to `AgentSideConnection`.
 */
export function muxAcpStream(stream: Stream, rpc: AcpRpc): Stream {
    const dest = stream.writable.getWriter();
    const writeMessage = (value: unknown): void => {
        void dest.write(value as AnyMessage).catch(() => {
            /* client gone */
        });
    };
    rpc.attachWriter(writeMessage);

    const acpWritable = new WritableStream<AnyMessage>({
        write(chunk) {
            return dest.write(chunk);
        },
        close() {
            return dest.close();
        },
        abort(reason) {
            return dest.abort(reason);
        },
    });

    const { readable, writable } = new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
            if (isInterceptedRequest(message, rpc)) {
                void rpc.dispatch(message.id, message.method, message.params);
                return;
            }
            controller.enqueue(message);
        },
    });
    void stream.readable.pipeTo(writable).catch(() => {
        /* peer closed */
    });
    return { readable, writable: acpWritable };
}
