// A route under an oMLX server's base address. Dashledge resolves each connection's
// address once (connections::resolve), keeping any reverse-proxy prefix as a
// directory, and hands collectors that base; Test requests the same URLs.
export const route = (server, path) => new URL(path.replace(/^\/+/, ""), server.base).href;
