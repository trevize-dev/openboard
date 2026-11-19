import { serve as honoServe } from "@hono/node-server";
import type { Openboard } from "@trevize-dev/openboard-core";
import { createApp, type ServerOptions } from "./index.js";

export interface NodeServeOptions extends ServerOptions {
  port?: number;
  hostname?: string;
}

/** Run the API on Node's http server. Resolves once listening. */
export function serve(ob: Openboard, options: NodeServeOptions = {}) {
  const app = createApp(ob, options);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = honoServe(
      { fetch: app.fetch, port: options.port ?? 7420, hostname: options.hostname ?? "127.0.0.1" },
      (info) => {
        const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
        resolve({
          url: `http://${host}:${info.port}`,
          close: () =>
            new Promise<void>((r) => {
              (server as { closeAllConnections?: () => void }).closeAllConnections?.();
              server.close(() => r());
            }),
        });
      },
    );
  });
}
