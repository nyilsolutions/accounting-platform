/**
 * The load balancer's health check for the web tasks (ADR 0030). It doesn't call the API, so an
 * API outage doesn't take the web tasks out of service too.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
