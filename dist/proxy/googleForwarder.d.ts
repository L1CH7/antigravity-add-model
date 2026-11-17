/**
 * Persistent HTTP/2 forwarder for native Google Cloud Code and AI Studio traffic.
 * Multiplexes requests over a warm HTTP/2 session with periodic PING frames during
 * active/warm windows to prevent ~33s idle-stream disconnects and cold TLS handshakes.
 */
import * as http from 'http';
import * as http2 from 'http2';
export interface ForwardToGoogleOptions {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    reqBody: Buffer;
    targetHost: string;
    isGeneration: boolean;
    shouldBufferAndModify: boolean;
    transformBody?: (body: string) => string;
    /** Optional overrides for timeouts, keepalive ping, and TLS options in tests. */
    streamTimeoutMs?: number;
    metadataTimeoutMs?: number;
    pingIntervalMs?: number;
    warmIdleMs?: number;
    sseKeepaliveMs?: number;
    http2ConnectOptions?: http2.SecureClientSessionOptions;
}
export interface FetchGoogleBufferOptions {
    targetHost: string;
    path: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    reqBody?: Buffer;
    timeoutMs?: number;
    pingIntervalMs?: number;
    warmIdleMs?: number;
    http2ConnectOptions?: http2.SecureClientSessionOptions;
}
export interface FetchGoogleBufferResult {
    statusCode: number;
    headers: Record<string, string | string[]>;
    body: Buffer;
}
export declare function resolveGoogleIpFamily(envValue?: string): 4 | 6 | undefined;
export declare function forwardToGoogle(opts: ForwardToGoogleOptions): void;
/**
 * Fetches a buffered response from Google over the shared warm HTTP/2 pool
 * with pre-header timeout enforcement, gzip decompression, and HTTP/1.1 fallback.
 */
export declare function fetchGoogleBuffer(opts: FetchGoogleBufferOptions): Promise<FetchGoogleBufferResult>;
export declare function stopGoogleForwarder(): void;
export declare function getGoogleForwarderStats(): {
    activeSessions: number;
    totalActiveStreams: number;
};
//# sourceMappingURL=googleForwarder.d.ts.map