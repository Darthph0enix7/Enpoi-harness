/**
 * Browser-trust fence for the sidebar routes: the canonical /api gateway
 * implementation in @deepseek-ai/dsh-client-connection
 * (src/api-request-trust.ts + src/loopback-hostname.ts), imported rather than
 * copied so the two fences cannot drift. Host-header loopback or a configured
 * trusted authority passes; cross-site browser markers refuse. This is a
 * DNS-rebinding / cross-site defense, not authentication.
 */
export { isLoopbackHostname, isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection'
